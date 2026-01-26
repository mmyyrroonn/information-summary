import { BackgroundJob, BackgroundJobStatus } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { countPendingTweets } from '../services/aiService';
import { enqueueJob } from './jobQueue';

export interface ClassificationTriggerOptions {
  force?: boolean;
  minPending?: number;
  pendingCount?: number;
}

export interface ClassificationTriggerResult {
  job?: BackgroundJob;
  created?: boolean;
  skipped?: boolean;
  reason?: 'none-pending' | 'below-threshold' | 'llm-inflight';
  pending: number;
  threshold?: number;
}

export async function requestClassificationRun(
  trigger: string,
  options?: ClassificationTriggerOptions
): Promise<ClassificationTriggerResult> {
  const pending =
    typeof options?.pendingCount === 'number' ? options.pendingCount : await countPendingTweets();

  if (pending === 0) {
    logger.info('No pending tweets for classification', {
      trigger,
      checkedAt: new Date().toISOString()
    });
    return { skipped: true, reason: 'none-pending', pending };
  }

  const inflightLlmJobs = await prisma.backgroundJob.count({
    where: {
      type: 'classify-tweets-llm',
      status: { in: [BackgroundJobStatus.PENDING, BackgroundJobStatus.RUNNING] }
    }
  });
  if (inflightLlmJobs > 0) {
    logger.info('LLM classification jobs in flight, skipping routing', {
      trigger,
      pending,
      inflight: inflightLlmJobs,
      checkedAt: new Date().toISOString()
    });
    return { skipped: true, reason: 'llm-inflight', pending };
  }

  const threshold = options?.minPending ?? config.CLASSIFY_MIN_TWEETS;
  if (!options?.force && pending < threshold) {
    logger.info('Pending tweets below threshold, waiting', {
      trigger,
      pending,
      threshold,
      checkedAt: new Date().toISOString()
    });
    return { skipped: true, reason: 'below-threshold', pending, threshold };
  }

  const { job, created } = await enqueueJob(
    'classify-tweets',
    {
      source: trigger,
      force: options?.force ?? false,
      pendingCount: pending
    },
    { dedupe: true }
  );

  if (created) {
    logger.info('Classification job enqueued', {
      trigger,
      pending,
      created,
      jobId: job.id,
      scheduledAt: job.scheduledAt.toISOString(),
      createdAt: job.createdAt.toISOString()
    });
  } else {
    logger.warn('Classification job already active', {
      trigger,
      pending,
      created,
      jobId: job.id,
      status: job.status,
      scheduledAt: job.scheduledAt.toISOString()
    });
  }
  return { job, created, skipped: false, pending };
}
