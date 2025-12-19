import { prisma } from '../db';

export interface SubscriptionTweetStats {
  subscriptionId: string;
  tweetsTotal: number;
  scoredTweets: number;
  avgImportance: number | null;
  highScoreTweets: number;
  highScoreRatio: number | null;
  firstTweetedAt: Date | null;
  lastTweetedAt: Date | null;
  avgTweetsPerDay: number | null;
}

export async function getSubscriptionTweetStats(options?: { highScoreMinImportance?: number }) {
  const highScoreMinImportance = options?.highScoreMinImportance ?? 4;

  const items = await prisma.$queryRaw<SubscriptionTweetStats[]>`
    SELECT
      s."id" as "subscriptionId",
      COUNT(t."id")::int as "tweetsTotal",
      COUNT(ti."importance")::int as "scoredTweets",
      AVG(ti."importance")::float8 as "avgImportance",
      SUM(CASE WHEN ti."importance" >= ${highScoreMinImportance} THEN 1 ELSE 0 END)::int as "highScoreTweets",
      CASE
        WHEN COUNT(ti."importance") = 0 THEN NULL
        ELSE (SUM(CASE WHEN ti."importance" >= ${highScoreMinImportance} THEN 1 ELSE 0 END)::float8 / COUNT(ti."importance")::float8)
      END as "highScoreRatio",
      MIN(t."tweetedAt") as "firstTweetedAt",
      MAX(t."tweetedAt") as "lastTweetedAt",
      CASE
        WHEN MIN(t."tweetedAt") IS NULL THEN NULL
        ELSE (COUNT(t."id")::float8 / GREATEST(1, (EXTRACT(EPOCH FROM MAX(t."tweetedAt") - MIN(t."tweetedAt")) / 86400.0) + 1))
      END as "avgTweetsPerDay"
    FROM "Subscription" s
    LEFT JOIN "Tweet" t ON t."subscriptionId" = s."id"
    LEFT JOIN "TweetInsight" ti ON ti."tweetId" = t."tweetId"
    GROUP BY s."id"
    ORDER BY s."createdAt" DESC
  `;

  return { highScoreMinImportance, items };
}

