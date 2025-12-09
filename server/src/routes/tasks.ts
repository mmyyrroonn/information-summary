import { Router } from 'express';
import { z } from 'zod';
import { fetchAllSubscriptions } from '../services/ingestService';
import { classifyTweets, generateReport, sendReportAndNotify } from '../services/aiService';

const router = Router();

router.post('/fetch', async (_req, res, next) => {
  try {
    const result = await fetchAllSubscriptions();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/analyze', async (_req, res, next) => {
  try {
    const result = await classifyTweets();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/report', async (req, res, next) => {
  try {
    const body = z.object({ notify: z.boolean().optional() }).parse(req.body ?? {});
    const report = await generateReport();
    if (body.notify) {
      await sendReportAndNotify(report);
    }
    res.json(report ?? { message: '没有可用的洞察' });
  } catch (error) {
    next(error);
  }
});

export default router;
