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

async function main() {
  const args = parseArgs(process.argv);

  const thresholds = {
    minAvgImportance: parseNumberArg(args.get('minAvg') ?? args.get('minAvgImportance'), 3.0),
    minHighScoreTweets: Math.floor(parseNumberArg(args.get('minHighCount') ?? args.get('minHighScoreTweets'), 6)),
    minHighScoreRatio: parseNumberArg(args.get('minHighRatio') ?? args.get('minHighScoreRatio'), 0.25),
    highScoreMinImportance: Math.floor(parseNumberArg(args.get('highMin') ?? args.get('highScoreMinImportance'), 4))
  };

  const apply = Boolean(args.get('apply'));

  const prisma = new PrismaClient();
  try {
    const [subscriptions, stats] = await Promise.all([
      prisma.subscription.findMany({ select: { id: true, screenName: true, status: true } }),
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

    const decisions = [];
    for (const sub of subscriptions) {
      const stat = statsById.get(sub.id) ?? null;
      const avgImportance = stat?.avgImportance ?? null;
      const scoredTweets = stat?.scoredTweets ?? 0;
      const highScoreTweets = stat?.highScoreTweets ?? 0;
      const highScoreRatio = stat?.highScoreRatio ?? null;

      const matchedAvg = typeof avgImportance === 'number' && avgImportance >= thresholds.minAvgImportance;
      const matchedHighCount = highScoreTweets >= thresholds.minHighScoreTweets;
      const ratio = normalizeRatio(highScoreRatio);
      const matchedHighRatio = typeof ratio === 'number' && ratio > thresholds.minHighScoreRatio;
      const keep = matchedAvg || matchedHighCount || matchedHighRatio;

      decisions.push({
        id: sub.id,
        screenName: sub.screenName,
        status: sub.status,
        avgImportance,
        scoredTweets,
        highScoreTweets,
        highScoreRatio,
        keep
      });
    }

    const candidates = decisions.filter((d) => d.status === SubscriptionStatus.SUBSCRIBED && !d.keep);

    console.log('Thresholds:', thresholds);
    console.log(`Evaluated: ${decisions.filter((d) => d.status === SubscriptionStatus.SUBSCRIBED).length}`);
    console.log(`Will unsubscribe: ${candidates.length}`);

    const preview = candidates
      .slice(0, 30)
      .map(
        (d) =>
          `@${d.screenName} avg=${typeof d.avgImportance === 'number' ? d.avgImportance.toFixed(2) : '-'} scored=${d.scoredTweets} high=${d.highScoreTweets} ratio=${typeof d.highScoreRatio === 'number' ? (d.highScoreRatio * 100).toFixed(1) + '%' : '-'}`
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
    const result = await prisma.subscription.updateMany({
      where: { id: { in: candidates.map((c) => c.id) }, status: SubscriptionStatus.SUBSCRIBED },
      data: { status: SubscriptionStatus.UNSUBSCRIBED, unsubscribedAt: now }
    });
    console.log(`\nUpdated: ${result.count}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
