import { Prisma } from '@prisma/client';
import { prisma } from '../db';

export interface ListTweetsOptions {
  page: number;
  pageSize: number;
  sort: 'newest' | 'oldest' | 'priority';
  subscriptionId?: string;
  startTime?: Date;
  endTime?: Date;
}

export async function listTweets(options: ListTweetsOptions) {
  const page = Math.max(1, options.page);
  const pageSize = Math.max(1, Math.min(50, options.pageSize));
  const skip = (page - 1) * pageSize;

  const where: Prisma.TweetWhereInput = {};
  if (options.subscriptionId) {
    where.subscriptionId = options.subscriptionId;
  }
  if (options.startTime || options.endTime) {
    where.tweetedAt = {};
    if (options.startTime) {
      where.tweetedAt.gte = options.startTime;
    }
    if (options.endTime) {
      where.tweetedAt.lte = options.endTime;
    }
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
