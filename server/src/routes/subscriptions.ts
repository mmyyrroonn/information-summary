import { Router } from 'express';
import { z } from 'zod';
import { SubscriptionStatus } from '@prisma/client';
import { createSubscription, deleteSubscription, listSubscriptions, setSubscriptionStatus } from '../services/subscriptionService';
import { fetchTweetsForSubscription } from '../services/ingestService';
import { importFollowingUsers, importListMembers } from '../services/subscriptionImportService';
import { getSubscriptionTweetStats } from '../services/subscriptionStatsService';
import { applyAutoUnsubscribe, evaluateAutoUnsubscribe } from '../services/subscriptionAutoUnsubscribeService';
import { prisma } from '../db';

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

router.get('/stats', async (_req, res, next) => {
  try {
    const [stats, total, subscribed, unsubscribed] = await Promise.all([
      getSubscriptionTweetStats(),
      prisma.subscription.count(),
      prisma.subscription.count({ where: { status: SubscriptionStatus.SUBSCRIBED } }),
      prisma.subscription.count({ where: { status: SubscriptionStatus.UNSUBSCRIBED } })
    ]);
    res.json({
      totals: { total, subscribed, unsubscribed },
      highScoreMinImportance: stats.highScoreMinImportance,
      items: stats.items
    });
  } catch (error) {
    next(error);
  }
});

router.post('/auto-unsubscribe', async (req, res, next) => {
  try {
    const body = z
      .object({
        minAvgImportance: z.number().optional(),
        minHighScoreTweets: z.number().int().optional(),
        minHighScoreRatio: z.number().optional(),
        highScoreMinImportance: z.number().int().optional(),
        dryRun: z.boolean().optional()
      })
      .parse(req.body ?? {});

    const thresholds = {
      minAvgImportance: body.minAvgImportance ?? 3.0,
      minHighScoreTweets: body.minHighScoreTweets ?? 6,
      minHighScoreRatio: body.minHighScoreRatio ?? 0.25,
      highScoreMinImportance: body.highScoreMinImportance ?? 4
    };

    const dryRun = body.dryRun ?? true;
    const result = dryRun ? await evaluateAutoUnsubscribe(thresholds) : await applyAutoUnsubscribe(thresholds);

    res.json({
      dryRun,
      thresholds,
      evaluated: result.evaluated,
      willUnsubscribe: result.candidates.length,
      updated: 'updated' in result ? result.updated : 0,
      candidates: result.candidates,
      items: result.items
    });
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

router.patch('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = z
      .object({
        status: z.nativeEnum(SubscriptionStatus)
      })
      .parse(req.body ?? {});
    const updated = await setSubscriptionStatus(id, body.status);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/fetch', async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = z
      .object({ force: z.boolean().optional(), allowUnsubscribed: z.boolean().optional() })
      .parse(req.body ?? {});
    const options: { force?: boolean; allowUnsubscribed?: boolean } = {};
    if (typeof body.force === 'boolean') {
      options.force = body.force;
    }
    if (typeof body.allowUnsubscribed === 'boolean') {
      options.allowUnsubscribed = body.allowUnsubscribed;
    }
    const result = await fetchTweetsForSubscription(id, options);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
