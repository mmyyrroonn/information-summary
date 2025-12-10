import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../logger';
import { enqueueJob } from './jobQueue';
import { requestClassificationRun } from './classificationTrigger';

export function startScheduler() {
  registerFetchJob();
  registerClassifyJob();
  registerReportJob();
}

function registerFetchJob() {
  const schedule = config.FETCH_CRON_SCHEDULE?.trim();
  if (!schedule) {
    logger.warn('FETCH_CRON_SCHEDULE not configured, skipping fetch job');
    return;
  }

  cron.schedule(schedule, () => {
    void enqueueFetchJob();
  });

  logger.info(`Fetch job registered with expression ${schedule}`);
}

function registerClassifyJob() {
  const schedule = config.CLASSIFY_CRON_SCHEDULE?.trim();
  if (!schedule) {
    logger.warn('CLASSIFY_CRON_SCHEDULE not configured, skipping classify job');
    return;
  }

  cron.schedule(schedule, () => {
    void requestClassificationRun('cron', { force: true });
  });

  logger.info(`Classify job registered with expression ${schedule}`);
}

function registerReportJob() {
  const schedule = config.REPORT_CRON_SCHEDULE?.trim();
  if (!schedule) {
    logger.warn('REPORT_CRON_SCHEDULE not configured, skipping report job');
    return;
  }

  cron.schedule(schedule, () => {
    void enqueueReportJob();
  });

  logger.info(`Report job registered with expression ${schedule}`);
}

async function enqueueFetchJob() {
  const { job, created } = await enqueueJob(
    'fetch-subscriptions',
    { limit: config.FETCH_BATCH_SIZE },
    { dedupe: true }
  );
  if (created) {
    logger.info('Fetch job enqueued', { jobId: job.id });
  } else {
    logger.warn('Fetch job already active, skip enqueue', { jobId: job.id });
  }
}

async function enqueueReportJob() {
  const { job, created } = await enqueueJob(
    'report-pipeline',
    { notify: true, trigger: 'cron' },
    { dedupe: true }
  );
  if (created) {
    logger.info('Report job enqueued', { jobId: job.id });
  } else {
    logger.warn('Report job already active, skip enqueue', { jobId: job.id });
  }
}
