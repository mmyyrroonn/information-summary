import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../logger';
import { fetchAllSubscriptions } from '../services/ingestService';
import { classifyTweets, countPendingTweets, generateReport, sendReportAndNotify } from '../services/aiService';

interface ClassificationTriggerOptions {
  force?: boolean;
  minPending?: number;
  pendingCount?: number;
}

let fetchJobRunning = false;
let classifyJobRunning = false;
let reportJobRunning = false;

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
    if (fetchJobRunning) {
      logger.warn('Previous fetch job still running, skipping this tick');
      return;
    }
    fetchJobRunning = true;
    runFetchBatch()
      .catch((error) => logger.error('Scheduled fetch batch failed', error))
      .finally(() => {
        fetchJobRunning = false;
      });
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
    void triggerClassification('cron', { force: true });
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
    if (reportJobRunning) {
      logger.warn('Previous report job still running, skipping this tick');
      return;
    }
    reportJobRunning = true;
    runReportPipeline()
      .catch((error) => logger.error('Scheduled report pipeline failed', error))
      .finally(() => {
        reportJobRunning = false;
      });
  });

  logger.info(`Report job registered with expression ${schedule}`);
}

async function runFetchBatch() {
  const batchSize = Math.max(1, config.FETCH_BATCH_SIZE);
  logger.info('Running scheduled fetch batch', { batchSize });
  const results = await fetchAllSubscriptions({ limit: batchSize });
  const fetched = results.filter((item) => !item.skipped && !item.error);
  const skipped = results.filter((item) => item.skipped);
  const inserted = fetched.reduce((sum, item) => sum + item.inserted, 0);
  logger.info('Fetch batch completed', { subscriptions: fetched.length, inserted, skipped: skipped.length });
  const pending = await countPendingTweets();
  await triggerClassification('fetch', { pendingCount: pending });
}

async function triggerClassification(source: string, options?: ClassificationTriggerOptions) {
  const pending = typeof options?.pendingCount === 'number' ? options.pendingCount : await countPendingTweets();
  if (pending === 0) {
    logger.info('No pending tweets for classification', { trigger: source });
    return;
  }

  const threshold = options?.minPending ?? config.CLASSIFY_MIN_TWEETS;
  if (!options?.force && pending < threshold) {
    logger.info('Pending tweets below threshold, waiting', { trigger: source, pending, threshold });
    return;
  }

  if (classifyJobRunning) {
    logger.warn('Classification job already running, skip new trigger', { trigger: source });
    return;
  }

  classifyJobRunning = true;
  logger.info('Starting classification job', { trigger: source, pending });
  try {
    const result = await classifyTweets();
    logger.info('Classification completed', { trigger: source, ...result });
  } catch (error) {
    logger.error('Classification job failed', error);
  } finally {
    classifyJobRunning = false;
  }
}

async function runReportPipeline() {
  logger.info('Running scheduled report pipeline');
  try {
    const report = await generateReport();
    if (!report) {
      logger.info('No report generated for the current window');
      return;
    }
    await sendReportAndNotify(report);
    logger.info('Report pipeline completed');
  } catch (error) {
    logger.error('Report pipeline failed', error);
  }
}
