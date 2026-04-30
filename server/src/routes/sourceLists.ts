import { Router } from 'express';
import cron from 'node-cron';
import { SourcePlatform, SubscriptionStatus } from '@prisma/client';
import { z } from 'zod';
import {
  createSourceList,
  deleteSource,
  deleteSourceList,
  getSourceList,
  importSubscriptionsToSourceList,
  listSourceLists,
  listSources,
  pauseUnlistedTwitterSubscriptions,
  updateSource,
  updateSourceList,
  upsertSource
} from '../services/sourceListService';
import { enqueueJob } from '../jobs/jobQueue';
import { serializeJob } from '../services/jobService';
import { refreshSourceListSchedules } from '../jobs/scheduler';
import { authMiddleware, adminOnly } from '../middleware/auth';

const router = Router();

router.use(authMiddleware);
router.use(adminOnly);

const cronSchema = z.string().min(1).refine((value) => cron.validate(value), { message: 'Invalid cron expression' });

const listCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
  scheduleCron: cronSchema.optional(),
  batchSize: z.coerce.number().int().positive().optional(),
  sourceCooldownHours: z.coerce.number().int().min(0).optional()
});

const listUpdateSchema = listCreateSchema.partial();

const sourceCreateSchema = z.object({
  platform: z.nativeEnum(SourcePlatform),
  identifier: z.string().min(1),
  displayName: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  subscriptionId: z.string().uuid().optional().nullable()
});

const sourceUpdateSchema = z.object({
  displayName: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional()
});

router.get('/', async (_req, res, next) => {
  try {
    res.json(await listSourceLists());
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = listCreateSchema.parse(req.body ?? {});
    const list = await createSourceList(body);
    await refreshSourceListSchedules();
    res.status(201).json(list);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const list = await getSourceList(params.id);
    if (!list) {
      res.status(404).json({ message: 'SourceList not found' });
      return;
    }
    res.json(list);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = listUpdateSchema.parse(req.body ?? {});
    const list = await updateSourceList(params.id, body);
    await refreshSourceListSchedules();
    res.json(list);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await deleteSourceList(params.id);
    await refreshSourceListSchedules();
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.get('/:id/sources', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    res.json(await listSources(params.id));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/sources', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = sourceCreateSchema.parse(req.body ?? {});
    const source = await upsertSource({ listId: params.id, ...body });
    res.status(201).json(source);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id/sources/:sourceId', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid(), sourceId: z.string().uuid() }).parse(req.params);
    const body = sourceUpdateSchema.parse(req.body ?? {});
    const source = await updateSource(params.sourceId, body);
    res.json(source);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/sources/:sourceId', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid(), sourceId: z.string().uuid() }).parse(req.params);
    await deleteSource(params.sourceId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/:id/import/subscriptions', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        subscriptionIds: z.array(z.string().uuid()).optional(),
        screenNames: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        status: z.nativeEnum(SubscriptionStatus).optional(),
        pauseUnlisted: z.boolean().optional(),
        dryRun: z.boolean().optional()
      })
      .parse(req.body ?? {});
    const result = await importSubscriptionsToSourceList(params.id, body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/pause-unlisted', async (_req, res, next) => {
  try {
    res.json(await pauseUnlistedTwitterSubscriptions());
  } catch (error) {
    next(error);
  }
});

router.post('/:id/fetch', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        limit: z.coerce.number().int().positive().optional(),
        force: z.boolean().optional(),
        dedupe: z.boolean().optional()
      })
      .parse(req.body ?? {});
    const payload = {
      sourceListId: params.id,
      trigger: 'manual',
      ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
      ...(typeof body.force === 'boolean' ? { force: body.force } : {})
    };
    const { job, created } = await enqueueJob('source-list-fetch', payload, { dedupe: body.dedupe ?? false });
    res.status(created ? 202 : 200).json({
      created,
      job: serializeJob(job),
      message: created ? 'SourceList fetch job enqueued' : 'SourceList fetch job already running'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
