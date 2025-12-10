import { Router } from 'express';
import { z } from 'zod';
import { createSubscription, deleteSubscription, listSubscriptions } from '../services/subscriptionService';
import { fetchTweetsForSubscription } from '../services/ingestService';
import { importFollowingUsers, importListMembers } from '../services/subscriptionImportService';

const router = Router();

router.get('/', async (_req, res, next) => {
  try {
    const subscriptions = await listSubscriptions();
    res.json(subscriptions);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const bodySchema = z.object({ screenName: z.string(), displayName: z.string().optional() });
    const body = bodySchema.parse(req.body);
    const payload: { screenName: string; displayName?: string } = { screenName: body.screenName };
    if (body.displayName) {
      payload.displayName = body.displayName;
    }
    const subscription = await createSubscription(payload);
    res.status(201).json(subscription);
  } catch (error) {
    next(error);
  }
});

router.post('/import/list', async (req, res, next) => {
  try {
    const body = z
      .object({
        listId: z.string().min(1, 'listId is required'),
        cursor: z.string().optional()
      })
      .parse(req.body ?? {});
    const options: { listId: string; cursor?: string } = { listId: body.listId };
    if (body.cursor) {
      options.cursor = body.cursor;
    }
    const result = await importListMembers(options);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/import/following', async (req, res, next) => {
  try {
    const body = z
      .object({
        screenName: z.string().optional(),
        userId: z.string().optional(),
        cursor: z.string().optional()
      })
      .refine((data) => Boolean(data.screenName || data.userId), {
        message: 'screenName or userId is required'
      })
      .parse(req.body ?? {});

    const options: { screenName?: string; userId?: string; cursor?: string } = {};
    if (body.screenName) {
      options.screenName = body.screenName;
    }
    if (body.userId) {
      options.userId = body.userId;
    }
    if (body.cursor) {
      options.cursor = body.cursor;
    }
    const result = await importFollowingUsers(options);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    await deleteSubscription(id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.post('/:id/fetch', async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = z.object({ force: z.boolean().optional() }).parse(req.body ?? {});
    const options: { force?: boolean } = {};
    if (typeof body.force === 'boolean') {
      options.force = body.force;
    }
    const result = await fetchTweetsForSubscription(id, options);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
