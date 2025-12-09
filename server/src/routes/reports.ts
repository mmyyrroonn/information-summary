import { Router } from 'express';
import { listReports, getReport } from '../services/reportService';
import { sendReportAndNotify } from '../services/aiService';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const reports = await listReports();
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
