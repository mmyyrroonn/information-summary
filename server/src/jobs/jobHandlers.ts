import { logger } from '../logger';
import { config } from '../config';
import { fetchAllSubscriptions } from '../services/ingestService';
import { classifyTweets, generateReportForProfile, sendReportAndNotify } from '../services/aiService';
import { getOrCreateDefaultReportProfile, getReportProfile } from '../services/reportProfileService';
import { withAiProcessingLock } from '../services/lockService';
import { JobPayloadMap, QueuedJob } from './jobQueue';

export async function handleFetchSubscriptionsJob(job: QueuedJob<'fetch-subscriptions'>) {
  const payload = (job.payload ?? {}) as JobPayloadMap['fetch-subscriptions'];
  const batchSize = Math.max(1, payload.limit ?? config.FETCH_BATCH_SIZE);
  const startedAt = Date.now();
  logger.info('Running queued fetch batch', {
    batchSize,
    force: payload.force ?? false,
    startedAt: new Date(startedAt).toISOString()
  });
  const options: { limit?: number; force?: boolean } = { limit: batchSize };
  if (typeof payload.force === 'boolean') {
    options.force = payload.force;
  }
  const results = await fetchAllSubscriptions(options);
  const fetched = results.filter((item) => !item.skipped && !item.error);
  const skipped = results.filter((item) => item.skipped);
  const inserted = fetched.reduce((sum, item) => sum + item.inserted, 0);
  const completedAt = Date.now();
  logger.info('Fetch batch completed', {
    subscriptions: fetched.length,
    inserted,
    skipped: skipped.length,
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt
  });
}

export async function handleClassifyTweetsJob(job: QueuedJob<'classify-tweets'>) {
  const payload = (job.payload ?? {}) as JobPayloadMap['classify-tweets'];
  const startedAt = Date.now();
  logger.info('Starting classification job', {
    trigger: payload.source ?? 'queue',
    pending: payload.pendingCount ?? null,
    startedAt: new Date(startedAt).toISOString()
  });
  try {
    const result = await classifyTweets({ lockHolderId: `job:${job.id}` });
    const completedAt = Date.now();
    logger.info('Classification completed', {
      trigger: payload.source ?? 'queue',
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      ...result
    });
  } catch (error) {
    logger.error('Classification job failed', error);
    throw error;
  }
}

export async function handleReportPipelineJob(job: QueuedJob<'report-pipeline'>) {
  const payload = (job.payload ?? {}) as JobPayloadMap['report-pipeline'];
  const shouldNotify = payload.notify ?? true;
  const startedAt = Date.now();
  const parsedWindowEnd = payload.windowEnd ? new Date(payload.windowEnd) : null;
  const windowEnd =
    parsedWindowEnd && Number.isNaN(parsedWindowEnd.getTime()) ? null : parsedWindowEnd;
  logger.info('Running queued report pipeline', {
    trigger: payload.trigger ?? 'queue',
    notify: shouldNotify,
    windowEnd: windowEnd?.toISOString() ?? null,
    startedAt: new Date(startedAt).toISOString()
  });
  try {
    const defaultProfile = await getOrCreateDefaultReportProfile();
    if (!defaultProfile.enabled) {
      logger.warn('Default report profile disabled, skipping job', { profileId: defaultProfile.id });
      return;
    }
    await withAiProcessingLock(
      `job:${job.id}`,
      async () => {
        const report = await generateReportForProfile(defaultProfile, windowEnd ?? undefined);
        if (!report) {
          logger.info('No report generated for the current window', {
            checkedAt: new Date().toISOString(),
            profileId: defaultProfile.id,
            durationMs: Date.now() - startedAt
          });
          return;
        }
        const notificationResult = { attempted: shouldNotify, delivered: false };

        if (shouldNotify) {
          try {
            await sendReportAndNotify(report);
            notificationResult.delivered = true;
          } catch (notifyError) {
            logger.error('Report notification failed, skipping Telegram delivery', {
              reportId: report.id,
              profileId: defaultProfile.id,
              error:
                notifyError instanceof Error
                  ? { message: notifyError.message, stack: notifyError.stack }
                  : notifyError
            });
          }
        }

        const completedAt = Date.now();

        if (notificationResult.delivered) {
          logger.info('Report pipeline completed with notification', {
            reportId: report.id,
            completedAt: new Date(completedAt).toISOString(),
            durationMs: completedAt - startedAt
          });
        } else {
          logger.info('Report generated without notification', {
            reportId: report.id,
            completedAt: new Date(completedAt).toISOString(),
            durationMs: completedAt - startedAt,
            notificationAttempted: notificationResult.attempted
          });
        }
      },
      { scope: 'report' }
    );
  } catch (error) {
    logger.error('Report pipeline failed', error);
    throw error;
  }
}

export async function handleReportProfileJob(job: QueuedJob<'report-profile'>) {
  const payload = (job.payload ?? {}) as JobPayloadMap['report-profile'];
  const startedAt = Date.now();
  const shouldNotify = payload.notify ?? true;
  const profileId = payload.profileId;
  const parsedWindowEnd = payload.windowEnd ? new Date(payload.windowEnd) : null;
  const windowEnd =
    parsedWindowEnd && Number.isNaN(parsedWindowEnd.getTime()) ? null : parsedWindowEnd;
  logger.info('Running queued report profile pipeline', {
    profileId,
    trigger: payload.trigger ?? 'queue',
    notify: shouldNotify,
    windowEnd: windowEnd?.toISOString() ?? null,
    startedAt: new Date(startedAt).toISOString()
  });

  const profile = await getReportProfile(profileId);
  if (!profile || !profile.enabled) {
    logger.warn('Report profile unavailable, skipping job', { profileId, enabled: profile?.enabled ?? null });
    return;
  }

  await withAiProcessingLock(
    `job:${job.id}`,
    async () => {
      const report = await generateReportForProfile(profile, windowEnd ?? undefined);
      if (!report) {
        logger.info('No report generated for profile window', {
          profileId,
          checkedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt
        });
        return;
      }

      const notificationResult = { attempted: shouldNotify, delivered: false };
      if (shouldNotify) {
        try {
          await sendReportAndNotify(report);
          notificationResult.delivered = true;
        } catch (notifyError) {
          logger.error('Report profile notification failed, skipping Telegram delivery', {
            reportId: report.id,
            profileId,
            error:
              notifyError instanceof Error
                ? { message: notifyError.message, stack: notifyError.stack }
                : notifyError
          });
        }
      }

      const completedAt = Date.now();
      if (notificationResult.delivered) {
        logger.info('Report profile pipeline completed with notification', {
          reportId: report.id,
          profileId,
          completedAt: new Date(completedAt).toISOString(),
          durationMs: completedAt - startedAt
        });
      } else {
        logger.info('Report profile generated without notification', {
          reportId: report.id,
          profileId,
          completedAt: new Date(completedAt).toISOString(),
          durationMs: completedAt - startedAt,
          notificationAttempted: notificationResult.attempted
        });
      }
    },
    { scope: 'report' }
  );
}

export async function handleJob(job: QueuedJob) {
  switch (job.type) {
    case 'fetch-subscriptions':
      await handleFetchSubscriptionsJob(job as QueuedJob<'fetch-subscriptions'>);
      break;
    case 'classify-tweets':
      await handleClassifyTweetsJob(job as QueuedJob<'classify-tweets'>);
      break;
    case 'report-pipeline':
      await handleReportPipelineJob(job as QueuedJob<'report-pipeline'>);
      break;
    case 'report-profile':
      await handleReportProfileJob(job as QueuedJob<'report-profile'>);
      break;
    default:
      logger.warn('Unknown job type encountered', { jobId: job.id, type: job.type });
  }
}
