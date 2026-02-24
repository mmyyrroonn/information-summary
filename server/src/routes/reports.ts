import { Router, Response } from 'express';
import { z } from 'zod';
import { listReports, getReport } from '../services/reportService';
import { sendHighScoreReport, sendReportAndNotify } from '../services/aiService';
import { publishReportToGithub } from '../services/githubPublishService';
import { enqueueJob } from '../jobs/jobQueue';
import { serializeJob } from '../services/jobService';
import { optionalAuthMiddleware, adminOnly, AuthRequest } from '../middleware/auth';

const router = Router();

router.use(optionalAuthMiddleware);

// GET /api/reports - list (default + own)
router.get('/', async (req: AuthRequest, res: Response, next) => {
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

router.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const reportId = req.params.id;
    if (!reportId) {
      return res.status(400).json({ message: 'Report id is required' });
    }
    const report = await getReport(reportId);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    if (req.user?.role === 'admin') {
      res.json(report);
      return;
    }
    res.json({
      ...report,
      outline: null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/send', adminOnly, async (req, res, next) => {
  try {
    const reportId = req.params.id;
    if (!reportId) {
      return res.status(400).json({ message: 'Report id is required' });
    }
    const report = await getReport(reportId);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    const result = await sendReportAndNotify(report);
    res.json(result ?? { message: 'No notification channel configured' });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/send-high-score', adminOnly, async (req, res, next) => {
  try {
    const reportId = req.params.id;
    if (!reportId) {
      return res.status(400).json({ message: 'Report id is required' });
    }
    const report = await getReport(reportId);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    const result = await sendHighScoreReport(report);
    if (!result.delivered) {
      const message =
        result.reason === 'no-high-score' ? 'No high-score items to send' : 'High-score Telegram config missing';
      return res.status(400).json({ message });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/publish', adminOnly, async (req, res, next) => {
  try {
    const reportId = req.params.id;
    if (!reportId) {
      return res.status(400).json({ message: 'Report id is required' });
    }
    const report = await getReport(reportId);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    const result = await publishReportToGithub(report);
    res.json({
      publishedAt: result.publishedAt,
      url: result.url,
      indexUrl: result.indexUrl
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/social', adminOnly, async (req, res, next) => {
  try {
    const body = z
      .object({
        prompt: z.string().optional(),
        maxItems: z.coerce.number().int().min(5).max(200).optional(),
        includeTweetText: z.boolean().optional(),
        tags: z.array(z.string().trim().min(1)).max(10).optional(),
        provider: z.enum(['deepseek', 'dashscope', 'auto']).optional()
      })
      .parse(req.body ?? {});
    const reportId = req.params.id;
    if (!reportId) {
      return res.status(400).json({ message: 'Report id is required' });
    }
    const report = await getReport(reportId);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    const payload: {
      reportId: string;
      prompt?: string;
      maxItems?: number;
      includeTweetText?: boolean;
      tags?: string[];
      provider?: 'deepseek' | 'dashscope' | 'auto';
    } = {
      reportId: report.id
    };
    if (body.prompt !== undefined) {
      payload.prompt = body.prompt;
    }
    if (typeof body.maxItems === 'number') {
      payload.maxItems = body.maxItems;
    }
    if (typeof body.includeTweetText === 'boolean') {
      payload.includeTweetText = body.includeTweetText;
    }
    if (Array.isArray(body.tags) && body.tags.length) {
      payload.tags = body.tags;
    }
    if (body.provider) {
      payload.provider = body.provider;
    }
    const { job, created } = await enqueueJob('social-digest', payload, { dedupe: false });
    res.status(created ? 202 : 200).json({
      created,
      job: serializeJob(job),
      message: created ? 'Social digest job enqueued' : 'Social digest job already running'
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/social-image-prompt', adminOnly, async (req, res, next) => {
  try {
    const body = z
      .object({
        prompt: z.string().optional(),
        maxItems: z.coerce.number().int().min(3).max(20).optional(),
        provider: z.enum(['deepseek', 'dashscope', 'auto']).optional(),
        digest: z.string().trim().min(1)
      })
      .parse(req.body ?? {});
    const reportId = req.params.id;
    if (!reportId) {
      return res.status(400).json({ message: 'Report id is required' });
    }
    const report = await getReport(reportId);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }
    const payload: {
      reportId: string;
      prompt?: string;
      maxItems?: number;
      provider?: 'deepseek' | 'dashscope' | 'auto';
      digest: string;
    } = { reportId: report.id, digest: body.digest };
    if (body.prompt !== undefined) {
      payload.prompt = body.prompt;
    }
    if (typeof body.maxItems === 'number') {
      payload.maxItems = body.maxItems;
    }
    if (body.provider) {
      payload.provider = body.provider;
    }
    const { job, created } = await enqueueJob('social-image-prompt', payload, { dedupe: false });
    res.status(created ? 202 : 200).json({
      created,
      job: serializeJob(job),
      message: created ? 'Social image prompt job enqueued' : 'Social image prompt job already running'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
