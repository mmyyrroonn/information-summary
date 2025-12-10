import { Router } from 'express';
import { z } from 'zod';
import { listTweets } from '../services/tweetService';
import { classifyTweetsByIds } from '../services/aiService';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const querySchema = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(20),
      order: z.enum(['asc', 'desc']).default('desc'),
      subscriptionId: z.string().uuid().optional()
    });
    const query = querySchema.parse(req.query);
    const tweets = await listTweets({
      page: query.page,
      pageSize: query.pageSize,
      order: query.order,
      ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {})
    });
    res.json(tweets);
  } catch (error) {
    next(error);
  }
});

router.post('/analyze', async (req, res, next) => {
  try {
    const bodySchema = z.object({
      tweetIds: z.array(z.string().uuid()).min(1).max(50)
    });
    const body = bodySchema.parse(req.body ?? {});
    const result = await classifyTweetsByIds(body.tweetIds);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
