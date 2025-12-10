import { Router } from 'express';
import { BackgroundJobStatus } from '@prisma/client';
import { z } from 'zod';
import { deleteJob, getJobById, listJobs } from '../services/jobService';

const router = Router();

const jobTypeSchema = z.enum(['fetch-subscriptions', 'classify-tweets', 'report-pipeline'] as const);

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

router.delete('/jobs/:id', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const job = await getJobById(params.id);
    if (!job) {
      res.status(404).json({ message: 'Job not found' });
      return;
    }
    await deleteJob(params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

export default router;
