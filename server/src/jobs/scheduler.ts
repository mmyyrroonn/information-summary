import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../logger';
import { fetchAllSubscriptions } from '../services/ingestService';
import { classifyTweets, generateReport, sendReportAndNotify } from '../services/aiService';

export function startScheduler() {
  if (!config.CRON_SCHEDULE) {
    logger.warn('Cron schedule not configured, skipping scheduler');
    return;
  }

  cron.schedule(config.CRON_SCHEDULE, async () => {
    logger.info('Running scheduled pipeline');
    try {
      await fetchAllSubscriptions();
      await classifyTweets();
      const report = await generateReport();
      await sendReportAndNotify(report);
    } catch (error) {
      logger.error('Scheduled pipeline failed', error);
    }
  });

  logger.info(`Scheduler registered with expression ${config.CRON_SCHEDULE}`);
}
