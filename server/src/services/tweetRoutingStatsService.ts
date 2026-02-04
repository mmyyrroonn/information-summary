import { Prisma, RoutingStatus } from '@prisma/client';
import { prisma } from '../db';

export interface TweetRoutingStatsOptions {
  startTime?: Date;
  endTime?: Date;
  subscriptionId?: string;
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
    ignoredOther
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
    })
  ]);

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
      llmTotal: llmRouted + llmQueued + llmCompleted,
      llmRouted,
      llmQueued,
      llmCompleted,
      pending,
      ignoredOther
    }
  };
}
