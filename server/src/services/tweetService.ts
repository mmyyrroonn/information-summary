import { Prisma } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { buildEmbeddingText } from './ai/embeddingText';
import { createEmbeddings, embeddingsEnabled } from './embeddingService';

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
  embeddingQuery?: string;
  importanceMin?: number;
  importanceMax?: number;
}

const EMBEDDING_TEXT_MAX_LENGTH = 320;
const EMBEDDING_SEARCH_CANDIDATE_LIMIT = 2000;

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

function dot(a: number[], b: number[]) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function normalizeVector(vector: number[]) {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i] ?? 0;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => (value ?? 0) / norm);
}

export async function listTweets(options: ListTweetsOptions) {
  const page = Math.max(1, options.page);
  const pageSize = Math.max(1, Math.min(50, options.pageSize));
  const skip = (page - 1) * pageSize;
  const embeddingQuery = options.embeddingQuery?.trim() ?? '';

  const hasExplicitRange = Boolean(options.startTime || options.endTime);
  const useDefaultSearchRange = Boolean((options.search || embeddingQuery) && !hasExplicitRange);
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

  const baseSelect = {
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
  } satisfies Prisma.TweetSelect;

  if (embeddingQuery) {
    if (!embeddingsEnabled()) {
      throw new Error('Embedding 搜索不可用：缺少 DASHSCOPE_API_KEY');
    }
    const queryText = buildEmbeddingText(embeddingQuery, EMBEDDING_TEXT_MAX_LENGTH);
    const [queryVector] = await createEmbeddings([queryText]);
    if (!Array.isArray(queryVector) || queryVector.length !== config.EMBEDDING_DIMENSIONS) {
      throw new Error('Embedding 搜索失败：向量维度不匹配');
    }
    const normalizedQuery = normalizeVector(queryVector);
    const candidateLimit = Math.max(EMBEDDING_SEARCH_CANDIDATE_LIMIT, page * pageSize);
    const candidates = await prisma.tweet.findMany({
      where,
      orderBy,
      select: {
        ...baseSelect,
        embedding: {
          select: {
            embedding: true,
            dimensions: true
          }
        }
      },
      take: candidateLimit
    });

    const matches = candidates.flatMap((tweet) => {
      const vector = tweet.embedding?.embedding;
      const dimensions = tweet.embedding?.dimensions;
      if (
        !Array.isArray(vector) ||
        dimensions !== config.EMBEDDING_DIMENSIONS ||
        vector.length !== config.EMBEDDING_DIMENSIONS
      ) {
        return [];
      }
      const score = dot(normalizeVector(vector), normalizedQuery);
      if (!Number.isFinite(score)) {
        return [];
      }
      const { embedding, ...rest } = tweet;
      return [{ tweet: rest, score }];
    });

    matches.sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      const aTime = new Date(a.tweet.tweetedAt).getTime();
      const bTime = new Date(b.tweet.tweetedAt).getTime();
      if (options.sort === 'oldest') {
        return aTime - bTime;
      }
      if (options.sort === 'priority') {
        const aImportance = a.tweet.insights?.importance ?? -1;
        const bImportance = b.tweet.insights?.importance ?? -1;
        if (aImportance !== bImportance) return bImportance - aImportance;
      }
      return bTime - aTime;
    });

    const total = matches.length;
    const items = matches.slice(skip, skip + pageSize).map((match) => ({
      ...match.tweet,
      embeddingScore: match.score
    }));

    return {
      page,
      pageSize,
      total,
      hasMore: skip + items.length < total,
      items
    };
  }

  const [total, tweets] = await prisma.$transaction([
    prisma.tweet.count({ where }),
    prisma.tweet.findMany({
      where,
      orderBy,
      select: baseSelect,
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
