import { randomUUID } from 'crypto';
import { logger } from '../logger';
import { handleJob } from './jobHandlers';
import { markJobComplete, markJobFailed, reserveNextJob } from './jobQueue';

const IDLE_SLEEP_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startJobWorker() {
  const workerId = randomUUID();
  logger.info('Background worker booting', { workerId });

  while (true) {
    const job = await reserveNextJob(workerId);
    if (!job) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    const jobStartTime = Date.now();
    const scheduledMs = job.scheduledAt ? job.scheduledAt.getTime() : null;
    const createdMs = job.createdAt ? job.createdAt.getTime() : null;
    const queueDelayMs = scheduledMs ? jobStartTime - scheduledMs : null;
    const sinceCreationMs = createdMs ? jobStartTime - createdMs : null;

    logger.info('Processing background job', {
      jobId: job.id,
      type: job.type,
      attempt: job.attempts,
      scheduledAt: job.scheduledAt?.toISOString(),
      createdAt: job.createdAt?.toISOString(),
      lockedAt: job.lockedAt?.toISOString(),
      startedAt: new Date(jobStartTime).toISOString(),
      queueDelayMs,
      sinceCreationMs
    });

    try {
      await handleJob(job);
      await markJobComplete(job.id);
      const completedAt = Date.now();
      logger.info('Background job completed', {
        jobId: job.id,
        type: job.type,
        completedAt: new Date(completedAt).toISOString(),
        durationMs: completedAt - jobStartTime
      });
    } catch (error) {
      const failedAt = Date.now();
      logger.error('Background job execution failed', {
        jobId: job.id,
        type: job.type,
        failedAt: new Date(failedAt).toISOString(),
        durationMs: failedAt - jobStartTime,
        error
      });
      await markJobFailed(job, error);
    }
  }
}
