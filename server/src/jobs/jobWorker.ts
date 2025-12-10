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

    logger.info('Processing background job', {
      jobId: job.id,
      type: job.type,
      attempt: job.attempts
    });

    try {
      await handleJob(job);
      await markJobComplete(job.id);
      logger.info('Background job completed', { jobId: job.id, type: job.type });
    } catch (error) {
      await markJobFailed(job, error);
    }
  }
}
