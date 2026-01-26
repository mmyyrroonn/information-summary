import { RoutingStatus, type Report } from '@prisma/client';
import { logger } from '../logger';
import { config } from '../config';
import { prisma } from '../db';
import { fetchAllSubscriptions } from '../services/ingestService';
import {
  classifyTweets,
  classifyTweetsByIdsWithTag,
  dispatchLlmClassificationJobs,
  generateReportForProfile,
  refreshRoutingEmbeddingCache,
  refreshRoutingEmbeddingCacheForTag,
  sendReportAndNotify
} from '../services/aiService';
import { publishReportToGithub } from '../services/githubPublishService';
import { getOrCreateDefaultReportProfile, getReportProfile } from '../services/reportProfileService';
import { withAiProcessingLock } from '../services/lockService';
import { enqueueJob, JobPayloadMap, QueuedJob } from './jobQueue';

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
    await enqueueJob(
      'classify-tweets-dispatch',
      { source: payload.source ?? 'queue' },
      { dedupe: true }
    );
    const completedAt = Date.now();
    logger.info('Classification completed', {
      trigger: payload.source ?? 'queue',
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      pending: result.pending,
      limited: result.limited,
      autoInsights: result.autoInsights,
      routedTweets: result.routedTweets,
      routedTags: result.routedTags
    });
  } catch (error) {
    logger.error('Classification job failed', error);
    throw error;
  }
}

export async function handleClassifyTweetsDispatchJob(job: QueuedJob<'classify-tweets-dispatch'>) {
  const payload = (job.payload ?? {}) as JobPayloadMap['classify-tweets-dispatch'];
  const startedAt = Date.now();
  logger.info('Starting classification dispatch job', {
    trigger: payload.source ?? 'queue',
    tagMin: payload.tagMin ?? null,
    startedAt: new Date(startedAt).toISOString()
  });
  try {
    const options = { source: payload.source ?? 'queue' } as { source: string; tagMin?: number };
    if (payload.tagMin !== undefined) {
      options.tagMin = payload.tagMin;
    }
    const result = await dispatchLlmClassificationJobs(options);
    const completedAt = Date.now();
    logger.info('Classification dispatch completed', {
      trigger: payload.source ?? 'queue',
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      ...result
    });
  } catch (error) {
    logger.error('Classification dispatch job failed', error);
    throw error;
  }
}

export async function handleClassifyTweetsLlmJob(job: QueuedJob<'classify-tweets-llm'>) {
  const payload = (job.payload ?? {}) as JobPayloadMap['classify-tweets-llm'];
  const startedAt = Date.now();
  logger.info('Starting LLM classification job', {
    trigger: payload.source ?? 'queue',
    batchSize: payload.tweetIds?.length ?? 0,
    tag: payload.tag ?? null,
    startedAt: new Date(startedAt).toISOString()
  });
  try {
    const result = await classifyTweetsByIdsWithTag(payload.tweetIds ?? [], payload.tag, {
      lockHolderId: `job:${job.id}`
    });
    const completedAt = Date.now();
    logger.info('LLM classification completed', {
      trigger: payload.source ?? 'queue',
      completedAt: new Date(completedAt).toISOString(),
      durationMs: completedAt - startedAt,
      tag: payload.tag ?? null,
      ...result
    });
  } catch (error) {
    if (payload.tweetIds?.length) {
      await prisma.tweet.updateMany({
        where: {
          id: { in: payload.tweetIds },
          routingStatus: RoutingStatus.LLM_QUEUED,
          insights: null,
          abandonedAt: null
        },
        data: {
          routingStatus: RoutingStatus.ROUTED,
          llmQueuedAt: null
        }
      });
    }
    logger.error('LLM classification job failed', error);
    throw error;
  }
}

export async function handleEmbeddingCacheRefreshJob(job: QueuedJob<'embedding-cache-refresh'>) {
  const payload = (job.payload ?? {}) as JobPayloadMap['embedding-cache-refresh'];
  const startedAt = Date.now();
  logger.info('Starting routing embedding cache refresh', {
    trigger: payload.source ?? 'queue',
    windowDays: payload.windowDays ?? null,
    samplePerTag: payload.samplePerTag ?? null,
    startedAt: new Date(startedAt).toISOString()
  });
  const result = await refreshRoutingEmbeddingCache(payload.source ?? 'queue', {
    ...(typeof payload.windowDays === 'number' ? { windowDays: payload.windowDays } : {}),
    ...(typeof payload.samplePerTag === 'number' ? { samplePerTag: payload.samplePerTag } : {})
  });
  const completedAt = Date.now();
  logger.info('Routing embedding cache refresh completed', {
    trigger: payload.source ?? 'queue',
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
    ...result
  });
}

export async function handleEmbeddingCacheRefreshTagJob(job: QueuedJob<'embedding-cache-refresh-tag'>) {
  const payload = (job.payload ?? {}) as JobPayloadMap['embedding-cache-refresh-tag'];
  if (!payload.tag) {
    logger.warn('Routing embedding cache tag refresh skipped, missing tag', { jobId: job.id });
    return;
  }
  const startedAt = Date.now();
  logger.info('Starting routing embedding cache tag refresh', {
    trigger: payload.source ?? 'queue',
    tag: payload.tag,
    startedAt: new Date(startedAt).toISOString()
  });
  const result = await refreshRoutingEmbeddingCacheForTag(payload.tag, payload.source ?? 'queue');
  const completedAt = Date.now();
  logger.info('Routing embedding cache tag refresh completed', {
    trigger: payload.source ?? 'queue',
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - startedAt,
    ...result
  });
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

        await autoPublishReport(report);
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

      await autoPublishReport(report);
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
    case 'classify-tweets-dispatch':
      await handleClassifyTweetsDispatchJob(job as QueuedJob<'classify-tweets-dispatch'>);
      break;
    case 'classify-tweets-llm':
      await handleClassifyTweetsLlmJob(job as QueuedJob<'classify-tweets-llm'>);
      break;
    case 'embedding-cache-refresh':
      await handleEmbeddingCacheRefreshJob(job as QueuedJob<'embedding-cache-refresh'>);
      break;
    case 'embedding-cache-refresh-tag':
      await handleEmbeddingCacheRefreshTagJob(job as QueuedJob<'embedding-cache-refresh-tag'>);
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

async function autoPublishReport(report: Report) {
  if (!config.GITHUB_PAGES_AUTO_PUBLISH) {
    return;
  }
  try {
    await publishReportToGithub(report);
  } catch (error) {
    logger.error('Report auto-publish failed', {
      reportId: report.id,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error
    });
  }
}
