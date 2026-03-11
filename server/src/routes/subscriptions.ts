import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { SubscriptionStatus } from '@prisma/client';
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  setSubscriptionStatus,
  updateSubscription
} from '../services/subscriptionService';
import { fetchTweetsForSubscription } from '../services/ingestService';
import { importFollowingUsers, importListMembers } from '../services/subscriptionImportService';
import { getSubscriptionTweetStats } from '../services/subscriptionStatsService';
import { applyAutoUnsubscribe, evaluateAutoUnsubscribe } from '../services/subscriptionAutoUnsubscribeService';
import { prisma } from '../db';
import { authMiddleware, adminOnly, AuthRequest } from '../middleware/auth';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// authMiddleware guarantees req.user is set

// GET /api/subscriptions - list all (default + own)
router.get('/', async (req: AuthRequest, res: Response, next) => {
  try {
    const userId = req.user!.userId;
    const whereClause = {
      OR: [{ userId: null }, { userId }]
    };
    const subscriptions = await prisma.subscription.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });
    res.json(subscriptions);
  } catch (error) {
    next(error);
  }
});

router.post('/', adminOnly, async (req: AuthRequest, res: Response, next) => {
  try {
    const bodySchema = z.object({
      screenName: z.string(),
      displayName: z.string().optional(),
      tags: z.array(z.string()).optional()
    });
    const body = bodySchema.parse(req.body);
    const payload: { screenName: string; displayName?: string; tags?: string[] } = { screenName: body.screenName };
    if (body.displayName) {
      payload.displayName = body.displayName;
    }
    if (body.tags) {
      payload.tags = body.tags;
    }
    const subscription = await createSubscription(payload);
    res.status(201).json(subscription);
  } catch (error) {
    next(error);
  }
});

router.post('/import/list', adminOnly, async (req: AuthRequest, res: Response, next) => {
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

router.post('/import/following', adminOnly, async (req: AuthRequest, res: Response, next) => {
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

router.get('/stats', adminOnly, async (_req: AuthRequest, res: Response, next) => {
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

router.post('/auto-unsubscribe', adminOnly, async (req: AuthRequest, res: Response, next) => {
  try {
    const body = z
      .object({
        minAvgImportance: z.number().optional(),
        minHighScoreTweets: z.number().int().optional(),
        minHighScoreRatio: z.number().optional(),
        highScoreMinImportance: z.number().int().optional(),
        protectNewSubscriptions: z.boolean().optional(),
        inactiveMonths: z.number().int().min(1).optional(),
        minRecentTweets: z.number().int().min(0).optional(),
        dryRun: z.boolean().optional()
      })
      .parse(req.body ?? {});

    const thresholds = {
      minAvgImportance: body.minAvgImportance ?? 3.0,
      minHighScoreTweets: body.minHighScoreTweets ?? 6,
      minHighScoreRatio: body.minHighScoreRatio ?? 0.25,
      highScoreMinImportance: body.highScoreMinImportance ?? 4,
      protectNewSubscriptions: body.protectNewSubscriptions ?? true,
      inactiveMonths: body.inactiveMonths ?? 2,
      minRecentTweets: body.minRecentTweets ?? 10
    };

    const dryRun = body.dryRun ?? true;
    const result = dryRun ? await evaluateAutoUnsubscribe(thresholds) : await applyAutoUnsubscribe(thresholds);
    const willUnsubscribe = result.toUnsubscribe.length;
    const willResubscribe = result.toResubscribe.length;
    const updatedUnsubscribed = 'updatedUnsubscribed' in result ? result.updatedUnsubscribed : 0;
    const updatedResubscribed = 'updatedResubscribed' in result ? result.updatedResubscribed : 0;

    res.json({
      dryRun,
      thresholds,
      evaluated: result.items.length,
      willUnsubscribe,
      willResubscribe,
      updatedUnsubscribed,
      updatedResubscribed,
      candidates: result.candidates
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', adminOnly, async (req: AuthRequest, res: Response, next) => {
  try {
        const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: 'Missing subscription id' });
    }
    await deleteSubscription(id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', adminOnly, async (req: AuthRequest, res: Response, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: 'Missing subscription id' });
    }
    const body = z
      .object({
        status: z.nativeEnum(SubscriptionStatus).optional(),
        tags: z.array(z.string()).optional()
      })
      .refine((data) => Boolean(data.status || data.tags), {
        message: 'status or tags is required'
      })
      .parse(req.body ?? {});
    if (body.tags) {
      const payload: { status?: SubscriptionStatus; tags?: string[] } = { tags: body.tags };
      if (body.status) {
        payload.status = body.status;
      }
      const updated = await updateSubscription(id, payload);
      res.json(updated);
      return;
    }
    const updated = await setSubscriptionStatus(id, body.status ?? SubscriptionStatus.SUBSCRIBED);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/fetch', adminOnly, async (req: AuthRequest, res: Response, next) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: 'Missing subscription id' });
    }
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
