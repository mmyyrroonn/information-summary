import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { fetchTimeline } from './twitterService';
import { config } from '../config';
import { endOfDay, startOfDay } from '../utils/time';
import { logger } from '../logger';

const tz = config.REPORT_TIMEZONE;

export async function fetchTweetsForSubscription(subscriptionId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!subscription) {
    throw new Error('Subscription not found');
  }
  return fetchTweets(subscription);
}

export async function fetchTweets(subscription: { id: string; screenName: string; displayName?: string | null }) {
  const timeline = await fetchTimeline(subscription.screenName);
  const tweets = timeline.timeline ?? [];
  const startWindow = startOfDay(new Date(), tz).toDate();
  const endWindow = endOfDay(new Date(), tz).toDate();

  let inserted = 0;
  for (const tweet of tweets) {
    const createdAt = new Date(tweet.created_at);
    if (createdAt < startWindow || createdAt > endWindow) {
      continue;
    }

    try {
      await prisma.tweet.upsert({
        where: { tweetId: tweet.tweet_id },
        update: {
          text: tweet.text,
          lang: tweet.lang ?? null,
          authorName: tweet.author.name,
          authorScreen: tweet.author.screen_name,
          raw: tweet as unknown as Prisma.InputJsonValue,
          tweetedAt: createdAt,
          tweetUrl: `https://twitter.com/${tweet.author.screen_name}/status/${tweet.tweet_id}`
        },
        create: {
          tweetId: tweet.tweet_id,
          subscriptionId: subscription.id,
          authorName: tweet.author.name,
          authorScreen: tweet.author.screen_name,
          text: tweet.text,
          lang: tweet.lang ?? null,
          raw: tweet as unknown as Prisma.InputJsonValue,
          tweetedAt: createdAt,
          tweetUrl: `https://twitter.com/${tweet.author.screen_name}/status/${tweet.tweet_id}`
        }
      });
      inserted += 1;
    } catch (err) {
      logger.error('Failed to upsert tweet', err);
    }
  }

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { lastFetchedAt: new Date() }
  });

  return {
    subscriptionId: subscription.id,
    screenName: subscription.screenName,
    processed: tweets.length,
    inserted
  };
}

export async function fetchAllSubscriptions() {
  const subs = await prisma.subscription.findMany();
  const results = [] as Array<{ subscriptionId: string; screenName: string; processed: number; inserted: number; error?: string }>;

  for (const sub of subs) {
    try {
      const result = await fetchTweets(sub);
      results.push(result);
    } catch (error) {
      logger.error(`Failed fetching timeline for ${sub.screenName}`, error);
      results.push({
        subscriptionId: sub.id,
        screenName: sub.screenName,
        processed: 0,
        inserted: 0,
        error: error instanceof Error ? error.message : 'unknown error'
      });
    }
  }

  return results;
}
