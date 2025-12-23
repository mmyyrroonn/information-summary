import { Router } from 'express';
import { z } from 'zod';
import { listReports, getReport } from '../services/reportService';
import { sendReportAndNotify } from '../services/aiService';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const query = z
      .object({
        profileId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional()
      })
      .parse(req.query);
    const options: { profileId?: string; limit?: number } = {};
    if (query.profileId) {
      options.profileId = query.profileId;
    }
    if (typeof query.limit === 'number') {
      options.limit = query.limit;
    }
    const reports = await listReports(options);
    res.json(reports);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const report = await getReport(req.params.id);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    res.json(report);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/send', async (req, res, next) => {
  try {
    const report = await getReport(req.params.id);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    const result = await sendReportAndNotify(report);
    res.json(result ?? { message: 'No notification channel configured' });
  } catch (error) {
    next(error);
  }
});

export default router;
