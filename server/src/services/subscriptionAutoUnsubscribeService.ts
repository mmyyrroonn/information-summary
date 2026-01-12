import { SubscriptionStatus } from '@prisma/client';
import { prisma } from '../db';
import { getSubscriptionTweetStats } from './subscriptionStatsService';

export interface AutoUnsubscribeThresholds {
  minAvgImportance: number;
  minHighScoreTweets: number;
  minHighScoreRatio: number;
  highScoreMinImportance: number;
  protectNewSubscriptions: boolean;
}

export type AutoSubscriptionAction = 'none' | 'unsubscribe' | 'resubscribe';

export interface AutoUnsubscribeDecisionItem {
  subscriptionId: string;
  screenName: string;
  status: SubscriptionStatus;
  desiredStatus: SubscriptionStatus;
  action: AutoSubscriptionAction;
  avgImportance: number | null;
  scoredTweets: number;
  highScoreTweets: number;
  highScoreRatio: number | null;
  matchedAvg: boolean;
  matchedHighCount: boolean;
  matchedHighRatio: boolean;
  decision: 'keep' | 'drop';
}

function normalizeRatio(value: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export async function evaluateAutoUnsubscribe(thresholds: AutoUnsubscribeThresholds) {
  const now = Date.now();
  const minCreatedAtMs = now - 14 * 24 * 60 * 60 * 1000;

  const [subscriptions, stats] = await Promise.all([
    prisma.subscription.findMany({
      select: { id: true, screenName: true, status: true, createdAt: true }
    }),
    getSubscriptionTweetStats({ highScoreMinImportance: thresholds.highScoreMinImportance })
  ]);

  const statsById = new Map(stats.items.map((item) => [item.subscriptionId, item]));
  const items: AutoUnsubscribeDecisionItem[] = [];

  for (const sub of subscriptions) {
    const stat = statsById.get(sub.id);
    const avgImportance = stat?.avgImportance ?? null;
    const scoredTweets = stat?.scoredTweets ?? 0;
    const highScoreTweets = stat?.highScoreTweets ?? 0;
    const highScoreRatio = stat?.highScoreRatio ?? null;

    const hasScoreData = scoredTweets > 0;
    const isNewSubscription = sub.createdAt.getTime() >= minCreatedAtMs;

    const matchedAvg = hasScoreData && typeof avgImportance === 'number' && avgImportance >= thresholds.minAvgImportance;
    const matchedHighCount = hasScoreData && highScoreTweets >= thresholds.minHighScoreTweets;
    const ratio = hasScoreData ? normalizeRatio(highScoreRatio) : null;
    const matchedHighRatio = hasScoreData && typeof ratio === 'number' && ratio > thresholds.minHighScoreRatio;

    const keep = matchedAvg || matchedHighCount || matchedHighRatio;
    const desiredStatus = keep ? SubscriptionStatus.SUBSCRIBED : SubscriptionStatus.UNSUBSCRIBED;

    const shouldFreeze = thresholds.protectNewSubscriptions && isNewSubscription;
    const action: AutoSubscriptionAction = shouldFreeze
      ? 'none'
      : sub.status === desiredStatus
        ? 'none'
        : desiredStatus === SubscriptionStatus.SUBSCRIBED
          ? 'resubscribe'
          : 'unsubscribe';
    const effectiveDesiredStatus = shouldFreeze ? sub.status : desiredStatus;

    items.push({
      subscriptionId: sub.id,
      screenName: sub.screenName,
      status: sub.status,
      desiredStatus: effectiveDesiredStatus,
      action,
      avgImportance,
      scoredTweets,
      highScoreTweets,
      highScoreRatio,
      matchedAvg,
      matchedHighCount,
      matchedHighRatio,
      decision: keep ? 'keep' : 'drop'
    });
  }

  const candidates = items.filter((item) => item.action !== 'none');
  const toUnsubscribe = candidates.filter((item) => item.action === 'unsubscribe');
  const toResubscribe = candidates.filter((item) => item.action === 'resubscribe');

  return {
    candidates,
    toUnsubscribe,
    toResubscribe,
    items
  };
}

export async function applyAutoUnsubscribe(thresholds: AutoUnsubscribeThresholds) {
  const evaluation = await evaluateAutoUnsubscribe(thresholds);
  const unsubIds = evaluation.toUnsubscribe.map((item) => item.subscriptionId);
  const resubIds = evaluation.toResubscribe.map((item) => item.subscriptionId);
  const now = new Date();

  const [unsubResult, resubResult] = await Promise.all([
    unsubIds.length
      ? prisma.subscription.updateMany({
          where: { id: { in: unsubIds }, status: SubscriptionStatus.SUBSCRIBED },
          data: { status: SubscriptionStatus.UNSUBSCRIBED, unsubscribedAt: now }
        })
      : Promise.resolve({ count: 0 }),
    resubIds.length
      ? prisma.subscription.updateMany({
          where: { id: { in: resubIds }, status: SubscriptionStatus.UNSUBSCRIBED },
          data: { status: SubscriptionStatus.SUBSCRIBED, unsubscribedAt: null }
        })
      : Promise.resolve({ count: 0 })
  ]);

  return { ...evaluation, updatedUnsubscribed: unsubResult.count, updatedResubscribed: resubResult.count };
}
