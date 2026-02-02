/* eslint-disable no-console */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config();
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
}

const { PrismaClient, Prisma } = require('@prisma/client');

const ROUTING_TAG_CACHE_ID = 'routing-tag-cache';
const ROUTING_NEGATIVE_KEY = '__low_quality__';
const DEFAULT_MIN_SAMPLE = 40;

function parseArgs(argv) {
  const args = new Map();
  for (const part of argv.slice(2)) {
    if (!part.startsWith('--')) continue;
    const [key, rawValue] = part.slice(2).split('=');
    args.set(key, rawValue ?? true);
  }
  return args;
}

function parseNumberArg(value, fallback) {
  if (value === undefined) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeStatus(value) {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase();
  return normalized.length ? normalized : null;
}

function ensureDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const user = encodeURIComponent(process.env.POSTGRES_USER || 'postgres');
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD || 'postgres');
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = process.env.POSTGRES_PORT || '5432';
  const db = process.env.POSTGRES_DB || 'information_summary';
  const url = `postgresql://${user}:${password}@${host}:${port}/${db}`;
  process.env.DATABASE_URL = url;
  return url;
}

function formatNumber(value, digits = 4) {
  if (value === null || value === undefined) return '-';
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(digits);
}

function formatCount(value) {
  if (!Number.isFinite(value)) return '-';
  return String(Math.trunc(value)).padStart(7);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function normalizeVector(vector) {
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

function dot(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function parseTagSamples(value, dimensions) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value;
  const parsed = {};
  Object.entries(record).forEach(([tag, entry]) => {
    if (!Array.isArray(entry)) return;
    const vectors = entry
      .map((vector) => {
        if (!Array.isArray(vector)) return null;
        const cleaned = vector.map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : 0));
        if (dimensions > 0 && cleaned.length !== dimensions) return null;
        return normalizeVector(cleaned);
      })
      .filter((item) => Array.isArray(item));
    if (vectors.length) {
      parsed[tag] = vectors;
    }
  });
  return parsed;
}

function topKMeanScore(vector, samples, k) {
  if (!samples.length) return -1;
  const top = [];
  let minIndex = -1;
  let minValue = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const score = dot(vector, sample);
    if (top.length < k) {
      top.push(score);
      if (score < minValue) {
        minValue = score;
        minIndex = top.length - 1;
      }
      continue;
    }
    if (score <= minValue) continue;
    top[minIndex] = score;
    minValue = top[0] ?? score;
    minIndex = 0;
    for (let i = 1; i < top.length; i += 1) {
      const value = top[i] ?? score;
      if (value < minValue) {
        minValue = value;
        minIndex = i;
      }
    }
  }
  const sum = top.reduce((acc, value) => acc + value, 0);
  return sum / top.length;
}

function buildCentroid(samples, dimensions) {
  if (!samples.length) return Array.from({ length: dimensions }, () => 0);
  const sum = Array.from({ length: dimensions }, () => 0);
  for (const vector of samples) {
    const n = Math.max(sum.length, vector.length);
    for (let i = 0; i < n; i += 1) {
      sum[i] = (sum[i] ?? 0) + (vector[i] ?? 0);
    }
  }
  return normalizeVector(sum);
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const clamped = Math.max(0, Math.min(1, q));
  const index = Math.floor((sorted.length - 1) * clamped);
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
}

function computeTagStats(samples, centroid) {
  if (!samples.length) {
    return { mean: 0, min: 0, max: 0, p25: 0, p50: 0, p75: 0, sampleCount: 0 };
  }
  const scores = samples.map((vector) => dot(vector, centroid)).sort((a, b) => a - b);
  const total = scores.reduce((acc, value) => acc + value, 0);
  return {
    mean: total / scores.length,
    min: scores[0] ?? 0,
    max: scores[scores.length - 1] ?? 0,
    p25: quantile(scores, 0.25),
    p50: quantile(scores, 0.5),
    p75: quantile(scores, 0.75),
    sampleCount: scores.length
  };
}

function computeQuantiles(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const pick = (q) => {
    const index = Math.floor((sorted.length - 1) * q);
    return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
  };
  const total = sorted.reduce((acc, value) => acc + value, 0);
  return {
    min: sorted[0],
    avg: total / sorted.length,
    p50: pick(0.5),
    p75: pick(0.75),
    p90: pick(0.9),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1]
  };
}

function computeCorrelation(xs, ys) {
  if (!xs.length || xs.length !== ys.length) return null;
  const n = xs.length;
  const meanX = xs.reduce((acc, v) => acc + v, 0) / n;
  const meanY = ys.reduce((acc, v) => acc + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const denom = Math.sqrt(denX * denY);
  return denom === 0 ? null : num / denom;
}

function computeTagScores(vector, tagList, tagSamples, kList) {
  const scoresByTag = new Map();
  const maxK = Math.max(...kList);
  for (const tag of tagList) {
    const samples = tagSamples[tag] || [];
    if (!samples.length) continue;
    const scoreTop1 = topKMeanScore(vector, samples, 1);
    const scoreTopMax = maxK === 1 ? scoreTop1 : topKMeanScore(vector, samples, maxK);
    const scores = new Map();
    for (const k of kList) {
      const score = k === 1 ? scoreTop1 : k === maxK ? scoreTopMax : topKMeanScore(vector, samples, k);
      scores.set(k, score);
    }
    scoresByTag.set(tag, scores);
  }
  return scoresByTag;
}

async function runStats({
  prisma,
  since,
  reason,
  reasonNot,
  status,
  bucketSize,
  uniqueK,
  tagList,
  tagSamples,
  cacheRecord,
  negativeSamples,
  negativeCentroid,
  label
}) {
  const statsByK = new Map();
  uniqueK.forEach((k) => {
    statsByK.set(k, {
      values: [],
      buckets: new Map()
    });
  });
  const negativeStats = {
    values: [],
    buckets: new Map()
  };
  const negativeMaxSimStats = {
    values: [],
    buckets: new Map()
  };
  const gapStats = new Map();
  const maxNegGapStats = new Map();
  const corrPairs = new Map();
  uniqueK.forEach((k) => {
    gapStats.set(k, { values: [], buckets: new Map() });
    maxNegGapStats.set(k, { values: [], buckets: new Map() });
    corrPairs.set(k, { xs: [], ys: [] });
  });

  let skipped = 0;
  let processed = 0;
  const batchSize = 500;
  let lastTweetedAt = null;
  let lastId = null;

  while (true) {
    const whereParts = [Prisma.sql`"tweetedAt" >= ${since}`];
    if (reason) whereParts.push(Prisma.sql`"routingReason" = ${reason}`);
    if (reasonNot) whereParts.push(Prisma.sql`"routingReason" IS DISTINCT FROM ${reasonNot}`);
    if (status) whereParts.push(Prisma.sql`"routingStatus" = CAST(${status} AS "RoutingStatus")`);
    if (lastTweetedAt && lastId) {
      whereParts.push(Prisma.sql`(t."tweetedAt", t."id") > (${lastTweetedAt}, ${lastId})`);
    }
    const whereClause = Prisma.join(whereParts, ' AND ');

    const rows = await prisma.$queryRaw`
      SELECT
        t."id",
        t."tweetId",
        t."tweetedAt",
        te."embedding"
      FROM "Tweet" t
      JOIN "TweetEmbedding" te ON te."tweetId" = t."tweetId"
      WHERE ${whereClause}
      ORDER BY t."tweetedAt" ASC, t."id" ASC
      LIMIT ${batchSize}
    `;

    if (!rows.length) break;
    lastTweetedAt = rows[rows.length - 1].tweetedAt;
    lastId = rows[rows.length - 1].id;

    for (const row of rows) {
      const vector = row.embedding;
      if (!Array.isArray(vector) || vector.length !== cacheRecord.dimensions) {
        skipped += 1;
        continue;
      }
      const normalized = normalizeVector(vector);
      const bestByK = new Map();
      uniqueK.forEach((k) => bestByK.set(k, { score: -1 }));

      for (const tag of tagList) {
        const samples = tagSamples[tag] || [];
        if (!samples.length) continue;
        const maxScore = topKMeanScore(normalized, samples, 1);
        const maxK = Math.max(...uniqueK);
        const meanScore = maxK === 1 ? maxScore : topKMeanScore(normalized, samples, maxK);

        for (const k of uniqueK) {
          const score = k === 1 ? maxScore : k === maxK ? meanScore : topKMeanScore(normalized, samples, k);
          const entry = bestByK.get(k);
          if (!entry || score > entry.score) {
            bestByK.set(k, { score });
          }
        }
      }

      for (const k of uniqueK) {
        const score = bestByK.get(k)?.score ?? -1;
        if (score < 0) continue;
        const stats = statsByK.get(k);
        stats.values.push(score);
        const bucket = Math.floor(score / bucketSize);
        stats.buckets.set(bucket, (stats.buckets.get(bucket) || 0) + 1);
      }

      let negativeScore = null;
      if (negativeCentroid) {
        negativeScore = dot(normalized, negativeCentroid);
        const negativeDistance = 1 - negativeScore;
        negativeStats.values.push(negativeDistance);
        const bucket = Math.floor(negativeDistance / bucketSize);
        negativeStats.buckets.set(bucket, (negativeStats.buckets.get(bucket) || 0) + 1);
      }

      let maxNegSim = null;
      if (negativeSamples.length) {
        let maxScore = -1;
        for (const neg of negativeSamples) {
          const score = dot(normalized, neg);
          if (score > maxScore) maxScore = score;
        }
        if (maxScore >= 0) {
          maxNegSim = maxScore;
          negativeMaxSimStats.values.push(maxScore);
          const bucket = Math.floor(maxScore / bucketSize);
          negativeMaxSimStats.buckets.set(bucket, (negativeMaxSimStats.buckets.get(bucket) || 0) + 1);
        }
      }

      if (negativeScore !== null) {
        for (const k of uniqueK) {
          const score = bestByK.get(k)?.score ?? -1;
          if (score < 0) continue;
          const gap = score - negativeScore;
          const stats = gapStats.get(k);
          stats.values.push(gap);
          const bucket = Math.floor(gap / bucketSize);
          stats.buckets.set(bucket, (stats.buckets.get(bucket) || 0) + 1);
        }
      }

      if (maxNegSim !== null) {
        for (const k of uniqueK) {
          const score = bestByK.get(k)?.score ?? -1;
          if (score < 0) continue;
          const gap = score - maxNegSim;
          const stats = maxNegGapStats.get(k);
          stats.values.push(gap);
          const bucket = Math.floor(gap / bucketSize);
          stats.buckets.set(bucket, (stats.buckets.get(bucket) || 0) + 1);
          const pairs = corrPairs.get(k);
          pairs.xs.push(score);
          pairs.ys.push(maxNegSim);
        }
      }

      processed += 1;
    }
  }

  console.log(`\n=== ${label} ===`);
  console.log(`Processed tweets: ${processed}`);
  console.log(`Skipped (missing/invalid embedding): ${skipped}`);

  for (const k of uniqueK) {
    const stats = statsByK.get(k);
    const values = stats.values;
    console.log(`\nTop-${k} best-score summary:`);
    const q = computeQuantiles(values);
    if (!q) {
      console.log('No scores available.');
      continue;
    }
    console.log(`min   ${formatNumber(q.min)}`);
    console.log(`avg   ${formatNumber(q.avg)}`);
    console.log(`p50   ${formatNumber(q.p50)}`);
    console.log(`p75   ${formatNumber(q.p75)}`);
    console.log(`p90   ${formatNumber(q.p90)}`);
    console.log(`p95   ${formatNumber(q.p95)}`);
    console.log(`p99   ${formatNumber(q.p99)}`);
    console.log(`max   ${formatNumber(q.max)}`);

    console.log(`\nTop-${k} histogram (bucket=${bucketSize}):`);
    const sortedBuckets = Array.from(stats.buckets.entries()).sort((a, b) => a[0] - b[0]);
    for (const [bucket, count] of sortedBuckets) {
      const start = bucket * bucketSize;
      const end = start + bucketSize;
      const ratio = values.length ? count / values.length : 0;
      console.log(
        `${formatNumber(start, 3)} - ${formatNumber(end, 3)}  ${String(count).padStart(7)} (${formatPercent(ratio)})`
      );
    }
  }

  if (negativeCentroid) {
    console.log(`\nNegative distance summary (1 - cosine to negative centroid):`);
    const q = computeQuantiles(negativeStats.values);
    if (!q) {
      console.log('No negative distance available.');
    } else {
      console.log(`min   ${formatNumber(q.min)}`);
      console.log(`avg   ${formatNumber(q.avg)}`);
      console.log(`p50   ${formatNumber(q.p50)}`);
      console.log(`p75   ${formatNumber(q.p75)}`);
      console.log(`p90   ${formatNumber(q.p90)}`);
      console.log(`p95   ${formatNumber(q.p95)}`);
      console.log(`p99   ${formatNumber(q.p99)}`);
      console.log(`max   ${formatNumber(q.max)}`);

      console.log(`\nNegative distance histogram (bucket=${bucketSize}):`);
      const sortedBuckets = Array.from(negativeStats.buckets.entries()).sort((a, b) => a[0] - b[0]);
      for (const [bucket, count] of sortedBuckets) {
        const start = bucket * bucketSize;
        const end = start + bucketSize;
        const ratio = negativeStats.values.length ? count / negativeStats.values.length : 0;
        console.log(
          `${formatNumber(start, 3)} - ${formatNumber(end, 3)}  ${String(count).padStart(7)} (${formatPercent(ratio)})`
        );
      }
    }
  } else {
    console.log('\nNegative distance summary: no negative centroid available in cache.');
  }

  if (negativeSamples.length) {
    console.log(`\nMax negative similarity summary (max cosine to negative samples):`);
    const q = computeQuantiles(negativeMaxSimStats.values);
    if (!q) {
      console.log('No negative similarity available.');
    } else {
      console.log(`min   ${formatNumber(q.min)}`);
      console.log(`avg   ${formatNumber(q.avg)}`);
      console.log(`p50   ${formatNumber(q.p50)}`);
      console.log(`p75   ${formatNumber(q.p75)}`);
      console.log(`p90   ${formatNumber(q.p90)}`);
      console.log(`p95   ${formatNumber(q.p95)}`);
      console.log(`p99   ${formatNumber(q.p99)}`);
      console.log(`max   ${formatNumber(q.max)}`);

      console.log(`\nMax negative similarity histogram (bucket=${bucketSize}):`);
      const sortedBuckets = Array.from(negativeMaxSimStats.buckets.entries()).sort((a, b) => a[0] - b[0]);
      for (const [bucket, count] of sortedBuckets) {
        const start = bucket * bucketSize;
        const end = start + bucketSize;
        const ratio = negativeMaxSimStats.values.length ? count / negativeMaxSimStats.values.length : 0;
        console.log(
          `${formatNumber(start, 3)} - ${formatNumber(end, 3)}  ${String(count).padStart(7)} (${formatPercent(ratio)})`
        );
      }
    }

    for (const k of uniqueK) {
      const stats = gapStats.get(k);
      const values = stats.values;
      console.log(`\nTop-${k} negative gap summary (bestScore - negativeScore):`);
      const qGap = computeQuantiles(values);
      if (!qGap) {
        console.log('No negative gap available.');
      } else {
        console.log(`min   ${formatNumber(qGap.min)}`);
        console.log(`avg   ${formatNumber(qGap.avg)}`);
        console.log(`p50   ${formatNumber(qGap.p50)}`);
        console.log(`p75   ${formatNumber(qGap.p75)}`);
        console.log(`p90   ${formatNumber(qGap.p90)}`);
        console.log(`p95   ${formatNumber(qGap.p95)}`);
        console.log(`p99   ${formatNumber(qGap.p99)}`);
        console.log(`max   ${formatNumber(qGap.max)}`);

        console.log(`\nTop-${k} negative gap histogram (bucket=${bucketSize}):`);
        const sortedGapBuckets = Array.from(stats.buckets.entries()).sort((a, b) => a[0] - b[0]);
        for (const [bucket, count] of sortedGapBuckets) {
          const start = bucket * bucketSize;
          const end = start + bucketSize;
          const ratio = values.length ? count / values.length : 0;
          console.log(
            `${formatNumber(start, 3)} - ${formatNumber(end, 3)}  ${String(count).padStart(7)} (${formatPercent(ratio)})`
          );
        }
      }
    }

    for (const k of uniqueK) {
      const stats = maxNegGapStats.get(k);
      const values = stats.values;
      console.log(`\nTop-${k} max-negative gap summary (bestScore - maxNegativeSim):`);
      const qGap = computeQuantiles(values);
      if (!qGap) {
        console.log('No max-negative gap available.');
      } else {
        console.log(`min   ${formatNumber(qGap.min)}`);
        console.log(`avg   ${formatNumber(qGap.avg)}`);
        console.log(`p50   ${formatNumber(qGap.p50)}`);
        console.log(`p75   ${formatNumber(qGap.p75)}`);
        console.log(`p90   ${formatNumber(qGap.p90)}`);
        console.log(`p95   ${formatNumber(qGap.p95)}`);
        console.log(`p99   ${formatNumber(qGap.p99)}`);
        console.log(`max   ${formatNumber(qGap.max)}`);

        const pairs = corrPairs.get(k);
        const corr = computeCorrelation(pairs.xs, pairs.ys);
        console.log(`corr(bestScore, maxNegativeSim) = ${corr === null ? '-' : corr.toFixed(4)}`);

        console.log(`\nTop-${k} max-negative gap histogram (bucket=${bucketSize}):`);
        const sortedGapBuckets = Array.from(stats.buckets.entries()).sort((a, b) => a[0] - b[0]);
        for (const [bucket, count] of sortedGapBuckets) {
          const start = bucket * bucketSize;
          const end = start + bucketSize;
          const ratio = values.length ? count / values.length : 0;
          console.log(
            `${formatNumber(start, 3)} - ${formatNumber(end, 3)}  ${String(count).padStart(7)} (${formatPercent(ratio)})`
          );
        }
      }
    }
  } else {
    console.log('\nMax negative similarity summary: no negative samples available in cache.');
  }
}

async function main() {
  ensureDatabaseUrl();
  const args = parseArgs(process.argv);
  const days = Math.max(1, Math.floor(parseNumberArg(args.get('days'), 2)));
  const sampleCount = Math.max(0, Math.floor(parseNumberArg(args.get('sample'), 0)));
  const topN = Math.max(1, Math.floor(parseNumberArg(args.get('top'), 20)));
  const reason = args.get('reason') ? String(args.get('reason')) : null;
  const status = normalizeStatus(args.get('status'));
  const bucketSize = Math.max(0.001, parseNumberArg(args.get('bucket'), 0.02));
  const kList = String(args.get('k') || '1,5')
    .split(',')
    .map((value) => Math.floor(Number(value.trim())))
    .filter((value) => Number.isFinite(value) && value > 0);
  const uniqueK = Array.from(new Set(kList.length ? kList : [1, 5])).sort((a, b) => a - b);
  const compare = args.get('compare') !== undefined;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const prisma = new PrismaClient();
  try {
    const statusRows = await prisma.$queryRaw`
      SELECT
        "routingStatus" AS status,
        COUNT(*)::int AS count
      FROM "Tweet"
      WHERE "tweetedAt" >= ${since}
      GROUP BY "routingStatus"
      ORDER BY count DESC
    `;
    const totalStatus = statusRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
    console.log(`Window: last ${days} days`);
    console.log(`Filters: ${reason ? `reason=${reason}` : 'reason=any'}, ${status ? `status=${status}` : 'status=any'}`);
    console.log('\nRouting status distribution:');
    for (const row of statusRows) {
      const count = Number(row.count || 0);
      const ratio = totalStatus ? count / totalStatus : 0;
      console.log(`${String(row.status).padEnd(12)} ${formatCount(count)} (${formatPercent(ratio)})`);
    }

    const reasonRows = await prisma.$queryRaw`
      SELECT
        COALESCE("routingReason", '(null)') AS reason,
        COUNT(*)::int AS count
      FROM "Tweet"
      WHERE "tweetedAt" >= ${since}
      ${status ? Prisma.sql`AND "routingStatus" = CAST(${status} AS "RoutingStatus")` : Prisma.empty}
      GROUP BY reason
      ORDER BY count DESC
      LIMIT ${topN}
    `;
    console.log(`\nTop routing reasons${status ? ` (status=${status})` : ''}:`);
    for (const row of reasonRows) {
      console.log(`${String(row.reason).padEnd(20)} ${formatCount(Number(row.count || 0))}`);
    }

    const [scoreStats] = await prisma.$queryRaw`
      SELECT
        COUNT(*)::int AS count,
        MIN("routingScore") AS min,
        MAX("routingScore") AS max,
        AVG("routingScore") AS avg,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "routingScore") AS p50,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY "routingScore") AS p75,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY "routingScore") AS p90,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "routingScore") AS p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY "routingScore") AS p99
      FROM "Tweet"
      WHERE "tweetedAt" >= ${since}
        AND "routingScore" IS NOT NULL
        ${reason ? Prisma.sql`AND "routingReason" = ${reason}` : Prisma.empty}
        ${status ? Prisma.sql`AND "routingStatus" = CAST(${status} AS "RoutingStatus")` : Prisma.empty}
    `;
    const scoreCount = Number(scoreStats?.count || 0);
    console.log(`\nRouting score summary (stored routingScore, count=${scoreCount}):`);
    if (scoreCount) {
      console.log(`min   ${formatNumber(scoreStats.min)}`);
      console.log(`avg   ${formatNumber(scoreStats.avg)}`);
      console.log(`p50   ${formatNumber(scoreStats.p50)}`);
      console.log(`p75   ${formatNumber(scoreStats.p75)}`);
      console.log(`p90   ${formatNumber(scoreStats.p90)}`);
      console.log(`p95   ${formatNumber(scoreStats.p95)}`);
      console.log(`p99   ${formatNumber(scoreStats.p99)}`);
      console.log(`max   ${formatNumber(scoreStats.max)}`);
    } else {
      console.log('No routingScore rows match filters.');
    }

    const scoreHistogram = await prisma.$queryRaw`
      SELECT
        FLOOR("routingScore" / ${bucketSize})::int AS bucket,
        COUNT(*)::int AS count
      FROM "Tweet"
      WHERE "tweetedAt" >= ${since}
        AND "routingScore" IS NOT NULL
        ${reason ? Prisma.sql`AND "routingReason" = ${reason}` : Prisma.empty}
        ${status ? Prisma.sql`AND "routingStatus" = CAST(${status} AS "RoutingStatus")` : Prisma.empty}
      GROUP BY bucket
      ORDER BY bucket
    `;
    if (scoreCount) {
      console.log(`\nRouting score histogram (bucket=${bucketSize}):`);
      for (const row of scoreHistogram) {
        const bucket = Number(row.bucket || 0);
        const count = Number(row.count || 0);
        const start = bucket * bucketSize;
        const end = start + bucketSize;
        const ratio = scoreCount ? count / scoreCount : 0;
        console.log(
          `${formatNumber(start, 3)} - ${formatNumber(end, 3)}  ${formatCount(count)} (${formatPercent(ratio)})`
        );
      }
    }

    const topTags = await prisma.$queryRaw`
      SELECT
        COALESCE("routingTag", '(null)') AS tag,
        COUNT(*)::int AS count,
        AVG("routingScore") AS avg
      FROM "Tweet"
      WHERE "tweetedAt" >= ${since}
        AND "routingScore" IS NOT NULL
        ${reason ? Prisma.sql`AND "routingReason" = ${reason}` : Prisma.empty}
        ${status ? Prisma.sql`AND "routingStatus" = CAST(${status} AS "RoutingStatus")` : Prisma.empty}
      GROUP BY tag
      ORDER BY count DESC
      LIMIT ${topN}
    `;
    if (topTags.length) {
      console.log('\nTop routing tags (by count):');
      for (const row of topTags) {
        console.log(`${String(row.tag).padEnd(18)} ${formatCount(Number(row.count || 0))} avg=${formatNumber(row.avg)}`);
      }
    }

    const cacheRows = await prisma.$queryRaw`
      SELECT
        "id",
        "model",
        "dimensions",
        "tagSamples"
      FROM "RoutingTagEmbeddingCache"
      WHERE "id" = ${ROUTING_TAG_CACHE_ID}
      LIMIT 1
    `;
    const cacheRecord = cacheRows?.[0];
    if (!cacheRecord) {
      console.error('Routing tag cache not found. Run a cache refresh first.');
      process.exit(1);
    }
    const tagSamples = parseTagSamples(cacheRecord.tagSamples, cacheRecord.dimensions);
    const tagList = Object.keys(tagSamples).filter((tag) => tag !== ROUTING_NEGATIVE_KEY);
    if (!tagList.length) {
      console.error('Routing tag cache has no samples.');
      process.exit(1);
    }
    const negativeSamples = tagSamples[ROUTING_NEGATIVE_KEY] || [];
    const negativeCentroid = negativeSamples.length
      ? buildCentroid(negativeSamples, cacheRecord.dimensions)
      : null;

    const tagMetrics = tagList
      .map((tag) => {
        const samples = tagSamples[tag] || [];
        const centroid = samples.length ? buildCentroid(samples, cacheRecord.dimensions) : null;
        const stats = centroid ? computeTagStats(samples, centroid) : null;
        const negativeSim = negativeCentroid && centroid ? dot(centroid, negativeCentroid) : null;
        const negativeDistance = negativeSim === null ? null : 1 - negativeSim;
        return {
          tag,
          sampleCount: samples.length,
          stats,
          negativeSim,
          negativeDistance
        };
      })
      .sort((a, b) => b.sampleCount - a.sampleCount);

    console.log('\nCache tag metrics (by sample count):');
    console.log('tag              samples   p25    p50    p75    mean   negSim negDist');
    for (const entry of tagMetrics) {
      const stats = entry.stats;
      const warn = entry.sampleCount < DEFAULT_MIN_SAMPLE ? '*' : ' ';
      console.log(
        `${(entry.tag + warn).padEnd(17)} ${formatCount(entry.sampleCount)}  ${formatNumber(stats?.p25)} ${formatNumber(
          stats?.p50
        )} ${formatNumber(stats?.p75)} ${formatNumber(stats?.mean)} ${formatNumber(entry.negativeSim)} ${formatNumber(
          entry.negativeDistance
        )}`
      );
    }
    console.log(`* sampleCount < ${DEFAULT_MIN_SAMPLE}`);

    await runStats({
      prisma,
      since,
      reason,
      reasonNot: null,
      status,
      bucketSize,
      uniqueK,
      tagList,
      tagSamples,
      cacheRecord,
      negativeSamples,
      negativeCentroid,
      label: 'Group A'
    });

    if (compare && reason) {
      await runStats({
        prisma,
        since,
        reason: null,
        reasonNot: reason,
        status,
        bucketSize,
        uniqueK,
        tagList,
        tagSamples,
        cacheRecord,
        negativeSamples,
        negativeCentroid,
        label: `Group B (routingReason != ${reason})`
      });
    }

    if (sampleCount > 0) {
      const whereParts = [Prisma.sql`"tweetedAt" >= ${since}`];
      if (reason) whereParts.push(Prisma.sql`"routingReason" = ${reason}`);
      if (status) whereParts.push(Prisma.sql`"routingStatus" = CAST(${status} AS "RoutingStatus")`);
      const whereClause = Prisma.join(whereParts, ' AND ');

      const samples = await prisma.$queryRaw`
        SELECT
          t."tweetId",
          t."text",
          te."embedding"
        FROM "Tweet" t
        JOIN "TweetEmbedding" te ON te."tweetId" = t."tweetId"
        WHERE ${whereClause}
        ORDER BY RANDOM()
        LIMIT ${sampleCount}
      `;

      console.log(`\nRandom sample (${sampleCount} tweets):`);
      for (const row of samples) {
        const vector = row.embedding;
        if (!Array.isArray(vector) || vector.length !== cacheRecord.dimensions) continue;
        const normalized = normalizeVector(vector);
        const scoresByTag = computeTagScores(normalized, tagList, tagSamples, uniqueK);
        const tagLines = [];
        for (const tag of tagList) {
          const scores = scoresByTag.get(tag);
          if (!scores) continue;
          const kParts = uniqueK.map((k) => `top${k}=${formatNumber(scores.get(k))}`).join(' ');
          tagLines.push(`${tag}: ${kParts}`);
        }
        console.log(`\nTweet ${row.tweetId}`);
        console.log(`Text: ${String(row.text || '').replace(/\s+/g, ' ').trim()}`);
        tagLines.sort();
        for (const line of tagLines) {
          console.log(`  ${line}`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
