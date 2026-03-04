import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import {
  CLASSIFY_ALLOWED_TAGS,
  DOMAIN_DISPLAY_NAMES,
  DOMAIN_SPECIFIC_TAGS,
  DOMAINS,
  SHARED_TAGS,
  TAG_DISPLAY_NAMES,
  TAG_FALLBACK_KEY
} from '../services/ai/shared';

const router = Router();

router.get('/routing', (_req, res) => {
  const tags = CLASSIFY_ALLOWED_TAGS.filter((tag) => tag !== TAG_FALLBACK_KEY).map((tag) => {
    let domain: string | null = null;
    for (const d of DOMAINS) {
      if ((DOMAIN_SPECIFIC_TAGS[d] as readonly string[]).includes(tag)) {
        domain = d;
        break;
      }
    }
    return {
      tag,
      label: TAG_DISPLAY_NAMES[tag] ?? tag,
      domain
    };
  });
  const domains = DOMAINS.map((d) => ({ domain: d, label: DOMAIN_DISPLAY_NAMES[d] }));
  res.json({ tags, domains });
});

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
