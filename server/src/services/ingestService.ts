import { Prisma, Subscription } from '@prisma/client';
import { prisma } from '../db';
import { fetchTimeline } from './twitterService';
import { config } from '../config';
import { formatDisplayDate } from '../utils/time';
import { logger } from '../logger';

const COOLDOWN_MS = config.FETCH_COOLDOWN_HOURS * 60 * 60 * 1000;

export interface SubscriptionFetchResult {
  subscriptionId: string;
  screenName: string;
  processed: number;
  inserted: number;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

interface FetchAllOptions {
  limit?: number;
  force?: boolean;
}

function nextAllowedAt(subscription: Pick<Subscription, 'lastFetchedAt'>) {
  if (!subscription.lastFetchedAt) return null;
  return new Date(subscription.lastFetchedAt.getTime() + COOLDOWN_MS);
}

function isCoolingDown(subscription: Pick<Subscription, 'lastFetchedAt'>, now = Date.now()) {
  const next = nextAllowedAt(subscription);
  if (!next) return false;
  return next.getTime() > now;
}

function buildCooldownReason(subscription: Pick<Subscription, 'lastFetchedAt'>) {
  const next = nextAllowedAt(subscription);
  if (!next) {
    return '等待冷却';
  }
  return `冷却中，预计 ${formatDisplayDate(next, config.REPORT_TIMEZONE)} 可再次抓取`;
}

export async function fetchTweetsForSubscription(subscriptionId: string, options?: { force?: boolean }) {
  const subscription = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!subscription) {
    throw new Error('Subscription not found');
  }
  if (!options?.force && isCoolingDown(subscription)) {
    const next = nextAllowedAt(subscription);
    throw new Error(
      `@${subscription.screenName} 距离上次抓取未满 ${config.FETCH_COOLDOWN_HOURS} 小时（下次 ${
        next ? formatDisplayDate(next, config.REPORT_TIMEZONE) : '稍后'
      }）`
    );
  }
  return fetchTweets(subscription);
}

export async function fetchTweets(subscription: { id: string; screenName: string; displayName?: string | null }) {
  const timeline = await fetchTimeline(subscription.screenName);
  const tweets = timeline.timeline ?? [];

  let inserted = 0;
  for (const tweet of tweets) {
    const createdAt = new Date(tweet.created_at);

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

export async function fetchAllSubscriptions(options: FetchAllOptions = {}) {
  const subs = await prisma.subscription.findMany({ orderBy: { lastFetchedAt: 'asc' } });
  const now = Date.now();
  const respectCooldown = !options.force;
  const dueSubs = respectCooldown ? subs.filter((sub) => !isCoolingDown(sub, now)) : subs;
  const hasLimit = typeof options.limit === 'number' && options.limit > 0;
  const queue = hasLimit ? dueSubs.slice(0, options.limit) : dueSubs;
  const selectedIds = new Set(queue.map((sub) => sub.id));
  const dueIds = new Set(dueSubs.map((sub) => sub.id));
  const results: SubscriptionFetchResult[] = [];

  for (const sub of subs) {
    if (respectCooldown && !dueIds.has(sub.id)) {
      results.push({
        subscriptionId: sub.id,
        screenName: sub.screenName,
        processed: 0,
        inserted: 0,
        skipped: true,
        reason: buildCooldownReason(sub)
      });
      continue;
    }

    if (!selectedIds.has(sub.id)) {
      results.push({
        subscriptionId: sub.id,
        screenName: sub.screenName,
        processed: 0,
        inserted: 0,
        skipped: true,
        reason: dueIds.has(sub.id) ? '等待后续批次' : buildCooldownReason(sub)
      });
      continue;
    }

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
