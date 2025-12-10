import { Router } from 'express';
import { BackgroundJobStatus } from '@prisma/client';
import { z } from 'zod';
import { enqueueJob } from '../jobs/jobQueue';
import { requestClassificationRun } from '../jobs/classificationTrigger';
import { getJobById, listJobs, serializeJob } from '../services/jobService';

const router = Router();
const jobTypeSchema = z.enum(['fetch-subscriptions', 'classify-tweets', 'report-pipeline'] as const);

router.post('/fetch', async (req, res, next) => {
  try {
    const body = z
      .object({
        limit: z.coerce.number().int().positive().optional(),
        force: z.boolean().optional(),
        dedupe: z.boolean().optional()
      })
      .parse(req.body ?? {});
    const payload: { limit?: number; force?: boolean } = {};
    if (typeof body.limit === 'number') {
      payload.limit = body.limit;
    }
    if (typeof body.force === 'boolean') {
      payload.force = body.force;
    }
    const { job, created } = await enqueueJob('fetch-subscriptions', payload, {
      dedupe: body.dedupe ?? false
    });
    res.status(created ? 202 : 200).json({
      created,
      job: serializeJob(job),
      message: created ? 'Fetch job enqueued' : 'Fetch job already running'
    });
  } catch (error) {
    next(error);
  }
});

router.post('/analyze', async (_req, res, next) => {
  try {
    const body = z
      .object({
        force: z.boolean().optional(),
        minPending: z.coerce.number().int().positive().optional()
      })
      .parse(_req.body ?? {});
    const triggerOptions: { force?: boolean; minPending?: number } = {
      force: body.force ?? true
    };
    if (typeof body.minPending === 'number') {
      triggerOptions.minPending = body.minPending;
    }
    const result = await requestClassificationRun('manual', triggerOptions);
    if (!result.job) {
      res.status(200).json({
        skipped: true,
        reason: result.reason ?? 'unknown',
        pending: result.pending,
        threshold: result.threshold ?? null
      });
      return;
    }
    res.status(result.created ? 202 : 200).json({
      job: serializeJob(result.job),
      created: result.created ?? false,
      pending: result.pending
    });
  } catch (error) {
    next(error);
  }
});

router.post('/report', async (req, res, next) => {
  try {
    const body = z
      .object({
        notify: z.boolean().optional(),
        dedupe: z.boolean().optional()
      })
      .parse(req.body ?? {});
    const payload = {
      notify: body.notify ?? true,
      trigger: 'manual'
    };
    const { job, created } = await enqueueJob('report-pipeline', payload, {
      dedupe: body.dedupe ?? false
    });
    res.status(created ? 202 : 200).json({
      created,
      job: serializeJob(job),
      notify: payload.notify
    });
  } catch (error) {
    next(error);
  }
});

router.get('/jobs', async (req, res, next) => {
  try {
    const query = z
      .object({
        type: jobTypeSchema.optional(),
        status: z.nativeEnum(BackgroundJobStatus).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional()
      })
      .parse(req.query);
    const jobs = await listJobs({
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.limit ? { limit: query.limit } : {})
    });
    res.json(jobs);
  } catch (error) {
    next(error);
  }
});

router.get('/jobs/:id', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const job = await getJobById(params.id);
    if (!job) {
      res.status(404).json({ message: 'Job not found' });
      return;
    }
    res.json(job);
  } catch (error) {
    next(error);
  }
});

export default router;
