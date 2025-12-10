import { BackgroundJob } from '@prisma/client';
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
  reason?: 'none-pending' | 'below-threshold';
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
    logger.info('No pending tweets for classification', { trigger });
    return { skipped: true, reason: 'none-pending', pending };
  }

  const threshold = options?.minPending ?? config.CLASSIFY_MIN_TWEETS;
  if (!options?.force && pending < threshold) {
    logger.info('Pending tweets below threshold, waiting', { trigger, pending, threshold });
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

  logger.info('Classification job enqueued', { trigger, pending, created });
  return { job, created, skipped: false, pending };
}
