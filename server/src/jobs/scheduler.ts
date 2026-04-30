import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../logger';
import { enqueueJob } from './jobQueue';
import { requestClassificationRun } from './classificationTrigger';
import { listEnabledReportProfiles } from '../services/reportProfileService';
import { archiveLegacyQueuedTweets, listEnabledSourceLists } from '../services/sourceListService';

type ReportProfileTask = ReturnType<typeof cron.schedule>;

const reportProfileTasks = new Map<string, ReportProfileTask>();
const sourceListTasks = new Map<string, ReportProfileTask>();

export function startScheduler() {
  registerFetchJob();
  registerClassifyJob();
  void archiveLegacyQueuedIfNeeded();
  void registerSourceListJobs();
  void registerReportProfileJobs();
}

export async function refreshReportProfileSchedules() {
  stopReportProfileTasks();
  await registerReportProfileJobs();
}

export async function refreshSourceListSchedules() {
  stopSourceListTasks();
  await registerSourceListJobs();
}

function registerFetchJob() {
  if (!config.LEGACY_FETCH_ENABLED) {
    logger.warn('Legacy fetch cron disabled', { LEGACY_FETCH_ENABLED: config.LEGACY_FETCH_ENABLED });
    return;
  }
  const schedule = config.FETCH_CRON_SCHEDULE?.trim();
  if (!schedule) {
    logger.warn('FETCH_CRON_SCHEDULE not configured, skipping fetch job');
    return;
  }

  cron.schedule(schedule, () => {
    const triggeredAt = new Date();
    logger.info('Fetch cron triggered', { schedule, triggeredAt: triggeredAt.toISOString() });
    void enqueueFetchJob();
  });

  logger.info(`Fetch job registered with expression ${schedule}`);
}

function registerClassifyJob() {
  if (!config.LEGACY_CLASSIFY_ENABLED) {
    logger.warn('Legacy classify cron disabled', { LEGACY_CLASSIFY_ENABLED: config.LEGACY_CLASSIFY_ENABLED });
    return;
  }
  const schedule = config.CLASSIFY_CRON_SCHEDULE?.trim();
  if (!schedule) {
    logger.warn('CLASSIFY_CRON_SCHEDULE not configured, skipping classify job');
    return;
  }

  cron.schedule(schedule, () => {
    const triggeredAt = new Date();
    logger.info('Classify cron triggered', { schedule, triggeredAt: triggeredAt.toISOString() });
    void requestClassificationRun('cron', { force: true });
    void enqueueJob('classify-tweets-dispatch', { source: 'cron' }, { dedupe: true });
  });

  logger.info(`Classify job registered with expression ${schedule}`);
}

async function archiveLegacyQueuedIfNeeded() {
  if (config.LEGACY_CLASSIFY_ENABLED) {
    return;
  }
  try {
    const result = await archiveLegacyQueuedTweets();
    if (result.updated > 0) {
      logger.warn('Archived legacy LLM queued tweets after disabling legacy classify', result);
    }
  } catch (error) {
    logger.error('Failed to archive legacy LLM queued tweets', error);
  }
}

async function registerSourceListJobs() {
  try {
    const lists = await listEnabledSourceLists();
    if (!lists.length) {
      logger.warn('No enabled source lists configured, skipping source list fetch scheduling');
      return;
    }
    lists.forEach((list) => {
      const schedule = list.scheduleCron?.trim() || config.SOURCE_LIST_FETCH_CRON_SCHEDULE;
      if (!cron.validate(schedule)) {
        logger.warn('Invalid source list cron expression, skipping list', {
          sourceListId: list.id,
          name: list.name,
          schedule
        });
        return;
      }
      const task = cron.schedule(schedule, () => {
        const triggeredAt = new Date();
        logger.info('Source list cron triggered', {
          sourceListId: list.id,
          name: list.name,
          schedule,
          triggeredAt: triggeredAt.toISOString()
        });
        void enqueueSourceListFetchJob(list.id, list.batchSize, triggeredAt);
      });
      sourceListTasks.set(list.id, task);
      logger.info('Source list fetch job registered', {
        sourceListId: list.id,
        name: list.name,
        schedule,
        batchSize: list.batchSize,
        sourceCooldownHours: list.sourceCooldownHours
      });
    });
  } catch (error) {
    logger.error('Failed to register source list jobs', error);
  }
}

async function registerReportProfileJobs() {
  try {
    const profiles = await listEnabledReportProfiles();
    if (!profiles.length) {
      logger.warn('No enabled report profiles configured, skipping report scheduling');
      return;
    }

    profiles.forEach((profile) => {
      const schedule = profile.scheduleCron?.trim();
      if (!schedule) {
        logger.warn('Report profile schedule missing, skipping profile', { profileId: profile.id, name: profile.name });
        return;
      }
      if (!cron.validate(schedule)) {
        logger.warn('Invalid report profile cron expression, skipping profile', {
          profileId: profile.id,
          name: profile.name,
          schedule
        });
        return;
      }
      const task = cron.schedule(
        schedule,
        () => {
          const triggeredAt = new Date();
          logger.info('Report profile cron triggered', {
            profileId: profile.id,
            name: profile.name,
            schedule,
            triggeredAt: triggeredAt.toISOString()
          });
          void enqueueReportProfileJob(profile.id, triggeredAt);
        },
        { timezone: profile.timezone }
      );
      reportProfileTasks.set(profile.id, task);
      logger.info('Report profile job registered', {
        profileId: profile.id,
        name: profile.name,
        schedule,
        timezone: profile.timezone
      });
    });
  } catch (error) {
    logger.error('Failed to register report profiles', error);
  }
}

function stopReportProfileTasks() {
  reportProfileTasks.forEach((task) => {
    task.stop();
  });
  reportProfileTasks.clear();
}

function stopSourceListTasks() {
  sourceListTasks.forEach((task) => {
    task.stop();
  });
  sourceListTasks.clear();
}

async function enqueueFetchJob() {
  const { job, created } = await enqueueJob(
    'fetch-subscriptions',
    { limit: config.FETCH_BATCH_SIZE },
    { dedupe: true }
  );
  if (created) {
    logger.info('Fetch job enqueued', {
      jobId: job.id,
      scheduledAt: job.scheduledAt.toISOString(),
      createdAt: job.createdAt.toISOString()
    });
  } else {
    logger.warn('Fetch job already active, skip enqueue', {
      jobId: job.id,
      scheduledAt: job.scheduledAt.toISOString(),
      status: job.status
    });
  }
}

async function enqueueSourceListFetchJob(sourceListId: string, batchSize: number, triggeredAt: Date) {
  const { job, created } = await enqueueJob(
    'source-list-fetch',
    { sourceListId, limit: batchSize, trigger: 'cron' },
    { dedupe: false }
  );
  logger.info('Source list fetch job enqueued', {
    jobId: job.id,
    sourceListId,
    created,
    triggeredAt: triggeredAt.toISOString(),
    scheduledAt: job.scheduledAt.toISOString(),
    createdAt: job.createdAt.toISOString()
  });
}

async function enqueueReportProfileJob(profileId: string, triggeredAt: Date) {
  const { job } = await enqueueJob(
    'report-profile',
    { profileId, notify: true, trigger: 'cron', windowEnd: triggeredAt.toISOString() },
    { dedupe: false }
  );
  logger.info('Report profile job enqueued', {
    jobId: job.id,
    profileId,
    scheduledAt: job.scheduledAt.toISOString(),
    createdAt: job.createdAt.toISOString()
  });
}
