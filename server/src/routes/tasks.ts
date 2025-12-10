import { Router } from 'express';
import { z } from 'zod';
import { fetchAllSubscriptions } from '../services/ingestService';
import { classifyTweets, generateReport, sendReportAndNotify } from '../services/aiService';
import { logger } from '../logger';

const router = Router();

router.post('/fetch', async (req, res, next) => {
  try {
    const body = z
      .object({
        limit: z.coerce.number().int().positive().optional(),
        force: z.boolean().optional()
      })
      .parse(req.body ?? {});
    const options: { limit?: number; force?: boolean } = {};
    if (typeof body.limit === 'number') {
      options.limit = body.limit;
    }
    if (typeof body.force === 'boolean') {
      options.force = body.force;
    }
    logger.info('Manual fetch triggered via API', {
      source: 'dashboard',
      limit: options.limit ?? null,
      force: options.force ?? false
    });
    const result = await fetchAllSubscriptions(options);
    const summary = result.reduce(
      (acc, item) => {
        if (item.error) {
          acc.errors += 1;
        } else if (item.skipped) {
          acc.skipped += 1;
        } else {
          acc.processed += 1;
          acc.inserted += item.inserted;
        }
        return acc;
      },
      { processed: 0, skipped: 0, errors: 0, inserted: 0 }
    );
    logger.info('Manual fetch completed', summary);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/analyze', async (_req, res, next) => {
  try {
    logger.info('Manual AI classification triggered via API', { source: 'dashboard' });
    const result = await classifyTweets();
    logger.info('Manual AI classification completed', result);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/report', async (req, res, next) => {
  try {
    const body = z.object({ notify: z.boolean().optional() }).parse(req.body ?? {});
    logger.info('Manual report generation triggered via API', { notify: body.notify ?? false });
    const report = await generateReport();
    if (body.notify) {
      if (!report) {
        logger.info('Report notification skipped because no report was generated');
      } else {
        logger.info('Sending manual report notification', { reportId: report.id });
        await sendReportAndNotify(report);
        logger.info('Manual report notification completed', { reportId: report.id });
      }
    }
    logger.info('Manual report generation completed', report ? { reportId: report.id } : { report: 'none' });
    res.json(report ?? { message: '没有可用的洞察' });
  } catch (error) {
    next(error);
  }
});

export default router;
