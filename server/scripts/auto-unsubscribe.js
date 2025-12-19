/* eslint-disable no-console */

const { PrismaClient, SubscriptionStatus } = require('@prisma/client');

function parseNumberArg(arg, fallback) {
  if (typeof arg !== 'string' || !arg.length) return fallback;
  const value = Number(arg);
  return Number.isFinite(value) ? value : fallback;
}

function parseArgs(argv) {
  const args = new Map();
  for (const part of argv.slice(2)) {
    if (!part.startsWith('--')) continue;
    const [key, rawValue] = part.slice(2).split('=');
    args.set(key, rawValue ?? true);
  }
  return args;
}

function normalizeRatio(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function decideAction(currentStatus, keep) {
  const desiredStatus = keep ? SubscriptionStatus.SUBSCRIBED : SubscriptionStatus.UNSUBSCRIBED;
  if (currentStatus === desiredStatus) return { action: 'none', desiredStatus };
  return desiredStatus === SubscriptionStatus.SUBSCRIBED
    ? { action: 'resubscribe', desiredStatus }
    : { action: 'unsubscribe', desiredStatus };
}

async function main() {
  const args = parseArgs(process.argv);

  const thresholds = {
    minAvgImportance: parseNumberArg(args.get('minAvg') ?? args.get('minAvgImportance'), 3.0),
    minHighScoreTweets: Math.floor(parseNumberArg(args.get('minHighCount') ?? args.get('minHighScoreTweets'), 6)),
    minHighScoreRatio: parseNumberArg(args.get('minHighRatio') ?? args.get('minHighScoreRatio'), 0.25),
    highScoreMinImportance: Math.floor(parseNumberArg(args.get('highMin') ?? args.get('highScoreMinImportance'), 4))
  };

  const apply = Boolean(args.get('apply'));
  const freezeDays = Math.floor(parseNumberArg(args.get('freezeDays'), 14));

  const prisma = new PrismaClient();
  try {
    const [subscriptions, stats] = await Promise.all([
      prisma.subscription.findMany({ select: { id: true, screenName: true, status: true, createdAt: true } }),
      prisma.$queryRaw`
        SELECT
          s."id" as "subscriptionId",
          COUNT(t."id")::int as "tweetsTotal",
          COUNT(ti."importance")::int as "scoredTweets",
          AVG(ti."importance")::float8 as "avgImportance",
          SUM(CASE WHEN ti."importance" >= ${thresholds.highScoreMinImportance} THEN 1 ELSE 0 END)::int as "highScoreTweets",
          CASE
            WHEN COUNT(ti."importance") = 0 THEN NULL
            ELSE (SUM(CASE WHEN ti."importance" >= ${thresholds.highScoreMinImportance} THEN 1 ELSE 0 END)::float8 / COUNT(ti."importance")::float8)
          END as "highScoreRatio"
        FROM "Subscription" s
        LEFT JOIN "Tweet" t ON t."subscriptionId" = s."id"
        LEFT JOIN "TweetInsight" ti ON ti."tweetId" = t."tweetId"
        GROUP BY s."id"
      `
    ]);

    const statsById = new Map(stats.map((item) => [item.subscriptionId, item]));
    const now = Date.now();
    const minCreatedAtMs = now - freezeDays * 24 * 60 * 60 * 1000;

    const decisions = [];
    for (const sub of subscriptions) {
      const stat = statsById.get(sub.id) ?? null;
      const avgImportance = stat?.avgImportance ?? null;
      const scoredTweets = stat?.scoredTweets ?? 0;
      const highScoreTweets = stat?.highScoreTweets ?? 0;
      const highScoreRatio = stat?.highScoreRatio ?? null;

      const hasScoreData = scoredTweets > 0;
      const isNewSubscription = sub.createdAt.getTime() >= minCreatedAtMs;
      const shouldFreeze = !hasScoreData || isNewSubscription;

      const matchedAvg = hasScoreData && typeof avgImportance === 'number' && avgImportance >= thresholds.minAvgImportance;
      const matchedHighCount = hasScoreData && highScoreTweets >= thresholds.minHighScoreTweets;
      const ratio = hasScoreData ? normalizeRatio(highScoreRatio) : null;
      const matchedHighRatio = hasScoreData && typeof ratio === 'number' && ratio > thresholds.minHighScoreRatio;
      const keep = matchedAvg || matchedHighCount || matchedHighRatio;
      const { action, desiredStatus } = decideAction(sub.status, keep);
      const effectiveAction = shouldFreeze ? 'none' : action;
      const effectiveDesiredStatus = shouldFreeze ? sub.status : desiredStatus;

      decisions.push({
        id: sub.id,
        screenName: sub.screenName,
        status: sub.status,
        desiredStatus: effectiveDesiredStatus,
        action: effectiveAction,
        avgImportance,
        scoredTweets,
        highScoreTweets,
        highScoreRatio,
        keep,
        shouldFreeze
      });
    }

    const toUnsubscribe = decisions.filter((d) => d.action === 'unsubscribe');
    const toResubscribe = decisions.filter((d) => d.action === 'resubscribe');
    const candidates = decisions.filter((d) => d.action !== 'none');

    console.log('Thresholds:', thresholds);
    console.log(`Freeze: skip if scoredTweets==0 OR createdAt within ${freezeDays} days`);
    console.log(`Evaluated: ${decisions.length}`);
    console.log(`Will unsubscribe: ${toUnsubscribe.length}`);
    console.log(`Will resubscribe: ${toResubscribe.length}`);

    const preview = candidates
      .slice(0, 30)
      .map(
        (d) =>
          `@${d.screenName} action=${d.action} avg=${typeof d.avgImportance === 'number' ? d.avgImportance.toFixed(2) : '-'} scored=${d.scoredTweets} high=${d.highScoreTweets} ratio=${typeof d.highScoreRatio === 'number' ? (d.highScoreRatio * 100).toFixed(1) + '%' : '-'}`
      )
      .join('\n');
    if (preview) {
      console.log('\nPreview (first 30):\n' + preview);
    }

    if (!apply) {
      console.log('\nDry-run only. Re-run with --apply to update DB.');
      return;
    }

    if (!candidates.length) {
      console.log('\nNo updates needed.');
      return;
    }

    const now = new Date();
    const [unsubResult, resubResult] = await Promise.all([
      toUnsubscribe.length
        ? prisma.subscription.updateMany({
            where: { id: { in: toUnsubscribe.map((c) => c.id) }, status: SubscriptionStatus.SUBSCRIBED },
            data: { status: SubscriptionStatus.UNSUBSCRIBED, unsubscribedAt: now }
          })
        : Promise.resolve({ count: 0 }),
      toResubscribe.length
        ? prisma.subscription.updateMany({
            where: { id: { in: toResubscribe.map((c) => c.id) }, status: SubscriptionStatus.UNSUBSCRIBED },
            data: { status: SubscriptionStatus.SUBSCRIBED, unsubscribedAt: null }
          })
        : Promise.resolve({ count: 0 })
    ]);
    console.log(`\nUpdated: unsubscribed=${unsubResult.count} resubscribed=${resubResult.count}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
