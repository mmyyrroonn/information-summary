import { SubscriptionStatus } from '@prisma/client';
import { prisma } from '../db';
import { getSubscriptionTweetStats } from './subscriptionStatsService';

export interface AutoUnsubscribeThresholds {
  minAvgImportance: number;
  minHighScoreTweets: number;
  minHighScoreRatio: number;
  highScoreMinImportance: number;
}

export interface AutoUnsubscribeDecisionItem {
  subscriptionId: string;
  screenName: string;
  status: SubscriptionStatus;
  avgImportance: number | null;
  scoredTweets: number;
  highScoreTweets: number;
  highScoreRatio: number | null;
  matchedAvg: boolean;
  matchedHighCount: boolean;
  matchedHighRatio: boolean;
  decision: 'keep' | 'unsubscribe';
}

function normalizeRatio(value: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export async function evaluateAutoUnsubscribe(thresholds: AutoUnsubscribeThresholds) {
  const [subscriptions, stats] = await Promise.all([
    prisma.subscription.findMany({
      select: { id: true, screenName: true, status: true }
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

    const matchedAvg = typeof avgImportance === 'number' && avgImportance >= thresholds.minAvgImportance;
    const matchedHighCount = highScoreTweets >= thresholds.minHighScoreTweets;
    const ratio = normalizeRatio(highScoreRatio);
    const matchedHighRatio = typeof ratio === 'number' && ratio > thresholds.minHighScoreRatio;

    const keep = matchedAvg || matchedHighCount || matchedHighRatio;

    items.push({
      subscriptionId: sub.id,
      screenName: sub.screenName,
      status: sub.status,
      avgImportance,
      scoredTweets,
      highScoreTweets,
      highScoreRatio,
      matchedAvg,
      matchedHighCount,
      matchedHighRatio,
      decision: keep ? 'keep' : 'unsubscribe'
    });
  }

  const evaluated = items.filter((item) => item.status === SubscriptionStatus.SUBSCRIBED).length;
  const candidates = items.filter(
    (item) => item.status === SubscriptionStatus.SUBSCRIBED && item.decision === 'unsubscribe'
  );

  return { evaluated, candidates, items };
}

export async function applyAutoUnsubscribe(thresholds: AutoUnsubscribeThresholds) {
  const evaluation = await evaluateAutoUnsubscribe(thresholds);
  const ids = evaluation.candidates.map((item) => item.subscriptionId);
  if (!ids.length) {
    return { ...evaluation, updated: 0 };
  }

  const now = new Date();
  const result = await prisma.subscription.updateMany({
    where: { id: { in: ids }, status: SubscriptionStatus.SUBSCRIBED },
    data: { status: SubscriptionStatus.UNSUBSCRIBED, unsubscribedAt: now }
  });

  return { ...evaluation, updated: result.count };
}
