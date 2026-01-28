import { Prisma } from '@prisma/client';
import { prisma } from '../db';

export interface ListTweetsOptions {
  page: number;
  pageSize: number;
  sort: 'newest' | 'oldest' | 'priority';
  routing?: 'default' | 'ignored' | 'all';
  routingTag?: string;
  routingScoreMin?: number;
  routingScoreMax?: number;
  subscriptionId?: string;
  startTime?: Date;
  endTime?: Date;
  search?: string;
  importanceMin?: number;
  importanceMax?: number;
}

function buildSearchFilter(raw?: string): Prisma.TweetWhereInput | null {
  if (!raw) {
    return null;
  }
  const groups = raw
    .trim()
    .split(';')
    .map((group) => group.split(',').map((term) => term.trim()).filter(Boolean))
    .filter((group) => group.length > 0);
  if (!groups.length) {
    return null;
  }

  const groupFilters: Prisma.TweetWhereInput[] = groups.map((group) => ({
    AND: group.map((term) => ({
      OR: [
        { text: { contains: term, mode: 'insensitive' } },
        { insights: { is: { summary: { contains: term, mode: 'insensitive' } } } },
        { insights: { is: { suggestions: { contains: term, mode: 'insensitive' } } } },
        { insights: { is: { verdict: { contains: term, mode: 'insensitive' } } } },
        { insights: { is: { tags: { has: term } } } }
      ]
    }))
  }));

  return { OR: groupFilters };
}

export async function listTweets(options: ListTweetsOptions) {
  const page = Math.max(1, options.page);
  const pageSize = Math.max(1, Math.min(50, options.pageSize));
  const skip = (page - 1) * pageSize;

  const hasExplicitRange = Boolean(options.startTime || options.endTime);
  const useDefaultSearchRange = Boolean(options.search && !hasExplicitRange);
  const searchEndTime = useDefaultSearchRange ? new Date() : options.endTime;
  const searchStartTime = useDefaultSearchRange
    ? new Date((searchEndTime ?? new Date()).getTime() - 24 * 60 * 60 * 1000)
    : options.startTime;

  const where: Prisma.TweetWhereInput = {};
  if (options.subscriptionId) {
    where.subscriptionId = options.subscriptionId;
  }
  if (options.routing === 'ignored') {
    where.routingStatus = 'IGNORED';
  } else if (options.routing === 'default') {
    where.routingStatus = { not: 'IGNORED' };
  }
  if (options.routingTag) {
    where.routingTag = options.routingTag;
  }
  if (typeof options.routingScoreMin === 'number' || typeof options.routingScoreMax === 'number') {
    where.routingScore = {};
    if (typeof options.routingScoreMin === 'number') {
      where.routingScore.gte = options.routingScoreMin;
    }
    if (typeof options.routingScoreMax === 'number') {
      where.routingScore.lte = options.routingScoreMax;
    }
  }
  if (searchStartTime || searchEndTime) {
    where.tweetedAt = {};
    if (searchStartTime) {
      where.tweetedAt.gte = searchStartTime;
    }
    if (searchEndTime) {
      where.tweetedAt.lte = searchEndTime;
    }
  }
  const searchFilter = buildSearchFilter(options.search);
  if (searchFilter) {
    const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
    where.AND = [...existingAnd, searchFilter];
  }
  if (typeof options.importanceMin === 'number' || typeof options.importanceMax === 'number') {
    const insightsFilter: Prisma.TweetInsightWhereInput = {};
    if (typeof options.importanceMin === 'number' || typeof options.importanceMax === 'number') {
      insightsFilter.importance = {};
      if (typeof options.importanceMin === 'number') {
        insightsFilter.importance.gte = options.importanceMin;
      }
      if (typeof options.importanceMax === 'number') {
        insightsFilter.importance.lte = options.importanceMax;
      }
    }
    const existingInsights =
      where.insights && 'is' in where.insights && where.insights.is ? where.insights.is : undefined;
    where.insights = { is: { ...(existingInsights ?? {}), ...insightsFilter } };
  }

  const orderBy: Prisma.Enumerable<Prisma.TweetOrderByWithRelationInput> =
    options.sort === 'priority'
      ? [
          { insights: { importance: { sort: 'desc', nulls: 'last' } } },
          { tweetedAt: 'desc' }
        ]
      : [{ tweetedAt: options.sort === 'oldest' ? 'asc' : 'desc' }];

  const [total, tweets] = await prisma.$transaction([
    prisma.tweet.count({ where }),
    prisma.tweet.findMany({
      where,
      orderBy,
      select: {
        id: true,
        tweetId: true,
        subscriptionId: true,
        authorName: true,
        authorScreen: true,
        text: true,
        tweetUrl: true,
        tweetedAt: true,
        createdAt: true,
        processedAt: true,
        routingStatus: true,
        routingTag: true,
        routingScore: true,
        routingMargin: true,
        routingReason: true,
        routedAt: true,
        llmQueuedAt: true,
        abandonedAt: true,
        abandonReason: true,
        insights: {
          select: {
            verdict: true,
            summary: true,
            importance: true,
            tags: true,
            suggestions: true,
            createdAt: true,
            updatedAt: true
          }
        }
      },
      skip,
      take: pageSize
    })
  ]);

  return {
    page,
    pageSize,
    total,
    hasMore: skip + tweets.length < total,
    items: tweets
  };
}
