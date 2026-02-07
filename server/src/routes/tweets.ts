import { Router } from 'express';
import { z } from 'zod';
import { listTweets } from '../services/tweetService';
import { classifyTweetsByIds } from '../services/aiService';
import { getTweetStats } from '../services/tweetStatsService';
import { getTweetRoutingStats } from '../services/tweetRoutingStatsService';

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

router.get('/routing-stats', async (req, res, next) => {
  try {
    const querySchema = z
      .object({
        subscriptionId: z.string().uuid().optional(),
        startTime: z.coerce.date().optional(),
        endTime: z.coerce.date().optional()
      })
      .refine((values) => !values.startTime || !values.endTime || values.startTime <= values.endTime, {
        path: ['endTime'],
        message: '开始时间必须早于结束时间'
      });
    const query = querySchema.parse(req.query);
    const stats = await getTweetRoutingStats({
      ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
      ...(query.startTime ? { startTime: query.startTime } : {}),
      ...(query.endTime ? { endTime: query.endTime } : {})
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
        includeTotal: z.enum(['0', '1']).optional().default('1').transform((value) => value === '1'),
        order: z.enum(['asc', 'desc']).optional(),
        sort: z.enum(['newest', 'oldest', 'priority']).optional(),
        routing: z.enum(['default', 'ignored', 'all']).optional(),
        routingTag: z.string().min(1).optional(),
        routingCategory: z
          .enum(['embedding-high', 'embedding-low', 'llm', 'ignored-other', 'pending'])
          .optional(),
        routingScoreMin: z.coerce.number().finite().optional(),
        routingScoreMax: z.coerce.number().finite().optional(),
        subscriptionId: z.string().uuid().optional(),
        startTime: z.coerce.date().optional(),
        endTime: z.coerce.date().optional(),
        q: z.string().optional(),
        embeddingQ: z.string().optional(),
        importanceMin: z.coerce.number().int().min(1).max(5).optional(),
        importanceMax: z.coerce.number().int().min(1).max(5).optional()
      })
      .transform((values) => ({
        ...values,
        sort: values.sort ?? (values.order === 'asc' ? 'oldest' : 'newest')
      }))
      .refine((values) => !values.startTime || !values.endTime || values.startTime <= values.endTime, {
        path: ['endTime'],
        message: '开始时间必须早于结束时间'
      })
      .refine(
        (values) =>
          values.routingScoreMin === undefined ||
          values.routingScoreMax === undefined ||
          values.routingScoreMin <= values.routingScoreMax,
        { path: ['routingScoreMax'], message: '相似度最小值必须小于最大值' }
      )
      .refine(
        (values) =>
          values.importanceMin === undefined ||
          values.importanceMax === undefined ||
          values.importanceMin <= values.importanceMax,
        { path: ['importanceMax'], message: '评分最小值必须小于最大值' }
      );
    const query = querySchema.parse(req.query);
    const tweets = await listTweets({
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort ?? 'newest',
      includeTotal: query.includeTotal,
      ...(query.routing ? { routing: query.routing } : {}),
      ...(query.routingCategory ? { routingCategory: query.routingCategory } : {}),
      ...(query.routingTag ? { routingTag: query.routingTag } : {}),
      ...(typeof query.routingScoreMin === 'number' ? { routingScoreMin: query.routingScoreMin } : {}),
      ...(typeof query.routingScoreMax === 'number' ? { routingScoreMax: query.routingScoreMax } : {}),
      ...(query.subscriptionId ? { subscriptionId: query.subscriptionId } : {}),
      ...(query.startTime ? { startTime: query.startTime } : {}),
      ...(query.endTime ? { endTime: query.endTime } : {}),
      ...(query.q ? { search: query.q } : {}),
      ...(query.embeddingQ ? { embeddingQuery: query.embeddingQ } : {}),
      ...(typeof query.importanceMin === 'number' ? { importanceMin: query.importanceMin } : {}),
      ...(typeof query.importanceMax === 'number' ? { importanceMax: query.importanceMax } : {})
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
