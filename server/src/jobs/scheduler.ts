import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../logger';
import { enqueueJob } from './jobQueue';
import { requestClassificationRun } from './classificationTrigger';
import { listEnabledReportProfiles } from '../services/reportProfileService';

type ReportProfileTask = ReturnType<typeof cron.schedule>;

const reportProfileTasks = new Map<string, ReportProfileTask>();

export function startScheduler() {
  registerFetchJob();
  registerClassifyJob();
  void registerReportProfileJobs();
}

export async function refreshReportProfileSchedules() {
  stopReportProfileTasks();
  await registerReportProfileJobs();
}

function registerFetchJob() {
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
  const schedule = config.CLASSIFY_CRON_SCHEDULE?.trim();
  if (!schedule) {
    logger.warn('CLASSIFY_CRON_SCHEDULE not configured, skipping classify job');
    return;
  }

  cron.schedule(schedule, () => {
    const triggeredAt = new Date();
    logger.info('Classify cron triggered', { schedule, triggeredAt: triggeredAt.toISOString() });
    void requestClassificationRun('cron', { force: true });
  });

  logger.info(`Classify job registered with expression ${schedule}`);
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
