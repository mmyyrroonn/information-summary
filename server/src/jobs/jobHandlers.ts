import { logger } from '../logger';
import { config } from '../config';
import { fetchAllSubscriptions } from '../services/ingestService';
import { classifyTweets, countPendingTweets, generateReport, sendReportAndNotify } from '../services/aiService';
import { JobPayloadMap, QueuedJob } from './jobQueue';
import { requestClassificationRun } from './classificationTrigger';

export async function handleFetchSubscriptionsJob(payload: JobPayloadMap['fetch-subscriptions']) {
  const batchSize = Math.max(1, payload.limit ?? config.FETCH_BATCH_SIZE);
  logger.info('Running queued fetch batch', { batchSize, force: payload.force ?? false });
  const options: { limit?: number; force?: boolean } = { limit: batchSize };
  if (typeof payload.force === 'boolean') {
    options.force = payload.force;
  }
  const results = await fetchAllSubscriptions(options);
  const fetched = results.filter((item) => !item.skipped && !item.error);
  const skipped = results.filter((item) => item.skipped);
  const inserted = fetched.reduce((sum, item) => sum + item.inserted, 0);
  logger.info('Fetch batch completed', {
    subscriptions: fetched.length,
    inserted,
    skipped: skipped.length
  });
  const pending = await countPendingTweets();
  await requestClassificationRun('fetch', { pendingCount: pending });
}

export async function handleClassifyTweetsJob(payload: JobPayloadMap['classify-tweets']) {
  logger.info('Starting classification job', {
    trigger: payload.source ?? 'queue',
    pending: payload.pendingCount ?? null
  });
  try {
    const result = await classifyTweets();
    logger.info('Classification completed', { trigger: payload.source ?? 'queue', ...result });
  } catch (error) {
    logger.error('Classification job failed', error);
    throw error;
  }
}

export async function handleReportPipelineJob(payload: JobPayloadMap['report-pipeline']) {
  const shouldNotify = payload.notify ?? true;
  logger.info('Running queued report pipeline', {
    trigger: payload.trigger ?? 'queue',
    notify: shouldNotify
  });
  try {
    const report = await generateReport();
    if (!report) {
      logger.info('No report generated for the current window');
      return;
    }
    if (shouldNotify) {
      await sendReportAndNotify(report);
      logger.info('Report pipeline completed with notification', { reportId: report.id });
    } else {
      logger.info('Report generated without notification', { reportId: report.id });
    }
  } catch (error) {
    logger.error('Report pipeline failed', error);
    throw error;
  }
}

export async function handleJob(job: QueuedJob) {
  switch (job.type) {
    case 'fetch-subscriptions':
      await handleFetchSubscriptionsJob((job.payload ?? {}) as JobPayloadMap['fetch-subscriptions']);
      break;
    case 'classify-tweets':
      await handleClassifyTweetsJob((job.payload ?? {}) as JobPayloadMap['classify-tweets']);
      break;
    case 'report-pipeline':
      await handleReportPipelineJob((job.payload ?? {}) as JobPayloadMap['report-pipeline']);
      break;
    default:
      logger.warn('Unknown job type encountered', { jobId: job.id, type: job.type });
  }
}
