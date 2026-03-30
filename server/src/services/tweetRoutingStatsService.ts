import { AiRunKind, AiRunStatus, Prisma, RoutingStatus } from '@prisma/client';
import { prisma } from '../db';

export interface TweetRoutingStatsOptions {
  startTime?: Date;
  endTime?: Date;
  subscriptionId?: string;
}

export interface ClassificationFailureStats {
  abandonedTotal: number;
  abandonedByReason: Array<{ reason: string; count: number }>;
  aiRunFailed: number;
  aiRunTotal: number;
  failureRate: number | null;
}

export interface TweetRoutingStatsResponse {
  range: {
    startTime: string | null;
    endTime: string | null;
    subscriptionId: string | null;
  };
  totals: {
    totalTweets: number;
    embeddingHigh: number;
    embeddingLow: number;
    llmTotal: number;
    llmRouted: number;
    llmQueued: number;
    llmCompleted: number;
    pending: number;
    ignoredOther: number;
  };
  classification: ClassificationFailureStats;
}

const EMBEDDING_LOW_REASONS = ['embed-low', 'embed-negative'];

export async function getTweetRoutingStats(
  options: TweetRoutingStatsOptions = {}
): Promise<TweetRoutingStatsResponse> {
  const where: Prisma.TweetWhereInput = {};
  if (options.subscriptionId) {
    where.subscriptionId = options.subscriptionId;
  }
  if (options.startTime || options.endTime) {
    const timeFilter: Prisma.DateTimeFilter = {};
    if (options.startTime) {
      timeFilter.gte = options.startTime;
    }
    if (options.endTime) {
      timeFilter.lte = options.endTime;
    }
    where.tweetedAt = timeFilter;
  }

  const [
    totalTweets,
    embeddingHigh,
    embeddingLow,
    llmRouted,
    llmQueued,
    llmCompleted,
    pending,
    ignoredOther,
    abandonedTotal
  ] = await prisma.$transaction([
    prisma.tweet.count({ where }),
    prisma.tweet.count({
      where: {
        ...where,
        routingStatus: RoutingStatus.AUTO_HIGH
      }
    }),
    prisma.tweet.count({
      where: {
        ...where,
        routingStatus: RoutingStatus.IGNORED,
        routingReason: { in: EMBEDDING_LOW_REASONS }
      }
    }),
    prisma.tweet.count({
      where: {
        ...where,
        routingStatus: RoutingStatus.ROUTED
      }
    }),
    prisma.tweet.count({
      where: {
        ...where,
        routingStatus: RoutingStatus.LLM_QUEUED
      }
    }),
    prisma.tweet.count({
      where: {
        ...where,
        routingStatus: RoutingStatus.COMPLETED
      }
    }),
    prisma.tweet.count({
      where: {
        ...where,
        routingStatus: RoutingStatus.PENDING
      }
    }),
    prisma.tweet.count({
      where: {
        ...where,
        routingStatus: RoutingStatus.IGNORED,
        OR: [{ routingReason: null }, { routingReason: { notIn: EMBEDDING_LOW_REASONS } }]
      }
    }),
    prisma.tweet.count({
      where: {
        ...where,
        abandonedAt: { not: null }
      }
    })
  ]);

  // Classification failure breakdown by abandon reason
  const abandonedGroups = await prisma.tweet.groupBy({
    by: ['abandonReason'],
    where: {
      ...where,
      abandonedAt: { not: null }
    },
    _count: { _all: true }
  });

  const abandonedByReason = abandonedGroups
    .map((group) => ({
      reason: group.abandonReason ?? 'unknown',
      count: group._count._all
    }))
    .sort((a, b) => b.count - a.count);

  // AiRun failure stats
  const aiRunWhere: Prisma.AiRunWhereInput = {
    kind: AiRunKind.TWEET_CLASSIFY
  };
  if (options.startTime || options.endTime) {
    const timeFilter: Prisma.DateTimeFilter = {};
    if (options.startTime) timeFilter.gte = options.startTime;
    if (options.endTime) timeFilter.lte = options.endTime;
    aiRunWhere.createdAt = timeFilter;
  }

  const [aiRunTotal, aiRunFailed] = await prisma.$transaction([
    prisma.aiRun.count({ where: aiRunWhere }),
    prisma.aiRun.count({ where: { ...aiRunWhere, status: AiRunStatus.FAILED } })
  ]);

  const llmTotal = llmRouted + llmQueued + llmCompleted;
  const classificationAttempted = llmCompleted + abandonedTotal;
  const failureRate = classificationAttempted > 0
    ? abandonedTotal / classificationAttempted
    : null;

  return {
    range: {
      startTime: options.startTime ? options.startTime.toISOString() : null,
      endTime: options.endTime ? options.endTime.toISOString() : null,
      subscriptionId: options.subscriptionId ?? null
    },
    totals: {
      totalTweets,
      embeddingHigh,
      embeddingLow,
      llmTotal,
      llmRouted,
      llmQueued,
      llmCompleted,
      pending,
      ignoredOther
    },
    classification: {
      abandonedTotal,
      abandonedByReason,
      aiRunFailed,
      aiRunTotal,
      failureRate
    }
  };
}
