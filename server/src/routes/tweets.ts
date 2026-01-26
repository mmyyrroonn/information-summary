import { Router } from 'express';
import { z } from 'zod';
import { listTweets } from '../services/tweetService';
import { classifyTweetsByIds } from '../services/aiService';
import { getTweetStats } from '../services/tweetStatsService';

const router = Router();

router.get('/stats', async (req, res, next) => {
  try {
    const querySchema = z
      .object({
        subscriptionId: z.string().uuid().optional(),
        startTime: z.coerce.date().optional(),
        endTime: z.coerce.date().optional(),
        highScoreMinImportance: z.coerce.number().int().min(1).max(5).optional(),
        tagLimit: z.coerce.number().int().min(1).max(30).optional(),
        authorLimit: z.coerce.number().int().min(1).max(20).optional()
      })
      .refine((values) => !values.startTime || !values.endTime || values.startTime <= values.endTime, {
        path: ['endTime'],
        message: '开始时间必须早于结束时间'
      });
    const query = querySchema.parse(req.query);
    const stats = await getTweetStats({
      ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
      ...(query.startTime ? { startTime: query.startTime } : {}),
      ...(query.endTime ? { endTime: query.endTime } : {}),
      ...(typeof query.highScoreMinImportance === 'number'
        ? { highScoreMinImportance: query.highScoreMinImportance }
        : {}),
      ...(typeof query.tagLimit === 'number' ? { tagLimit: query.tagLimit } : {}),
      ...(typeof query.authorLimit === 'number' ? { authorLimit: query.authorLimit } : {})
    });
    res.json(stats);
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const querySchema = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20),
        order: z.enum(['asc', 'desc']).optional(),
        sort: z.enum(['newest', 'oldest', 'priority']).optional(),
        routing: z.enum(['default', 'ignored', 'all']).optional(),
        subscriptionId: z.string().uuid().optional(),
        startTime: z.coerce.date().optional(),
        endTime: z.coerce.date().optional(),
        q: z.string().optional()
      })
      .transform((values) => ({
        ...values,
        sort: values.sort ?? (values.order === 'asc' ? 'oldest' : 'newest')
      }))
      .refine(
        (values) => !values.startTime || !values.endTime || values.startTime <= values.endTime,
        { path: ['endTime'], message: '开始时间必须早于结束时间' }
      );
    const query = querySchema.parse(req.query);
    const tweets = await listTweets({
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort ?? 'newest',
      ...(query.routing ? { routing: query.routing } : {}),
      ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
      ...(query.startTime ? { startTime: query.startTime } : {}),
      ...(query.endTime ? { endTime: query.endTime } : {}),
      ...(query.q ? { search: query.q } : {})
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
