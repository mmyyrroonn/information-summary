import { Router } from 'express';
import { z } from 'zod';
import { createSubscription, deleteSubscription, listSubscriptions } from '../services/subscriptionService';
import { fetchTweetsForSubscription } from '../services/ingestService';

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
