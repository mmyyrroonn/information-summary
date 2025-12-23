import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).optional()
      })
      .parse(req.query);
    const limit = query.limit ?? 100;

    const tweetTags = await prisma.$queryRaw<{ tag: string; count: number }[]>`
      SELECT LOWER(TRIM(tag.value)) AS tag, COUNT(*)::int AS count
      FROM "TweetInsight"
      CROSS JOIN LATERAL unnest("TweetInsight"."tags") AS tag(value)
      WHERE tag.value IS NOT NULL AND TRIM(tag.value) <> ''
      GROUP BY LOWER(TRIM(tag.value))
      ORDER BY count DESC
      LIMIT ${limit};
    `;

    const authorTags = await prisma.$queryRaw<{ tag: string; count: number }[]>`
      SELECT LOWER(TRIM(tag.value)) AS tag, COUNT(*)::int AS count
      FROM "Subscription"
      CROSS JOIN LATERAL unnest("Subscription"."tags") AS tag(value)
      WHERE tag.value IS NOT NULL AND TRIM(tag.value) <> ''
      GROUP BY LOWER(TRIM(tag.value))
      ORDER BY count DESC
      LIMIT ${limit};
    `;

    res.json({ tweetTags, authorTags });
  } catch (error) {
    next(error);
  }
});

export default router;
