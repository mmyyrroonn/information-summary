/* eslint-disable no-console */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config();
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
}

const { PrismaClient, Prisma } = require('@prisma/client');

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

function formatPercent(value) {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function describeFilters({ days, reason, status }) {
  const parts = [`last ${days} days`];
  if (reason) parts.push(`reason=${reason}`);
  if (status) parts.push(`status=${status}`);
  return parts.join(', ');
}

async function main() {
  ensureDatabaseUrl();
  const args = parseArgs(process.argv);
  const days = Math.max(1, Math.floor(parseNumberArg(args.get('days'), 30)));
  const reason = args.get('reason') ? String(args.get('reason')) : 'embed-low';
  const status = normalizeStatus(args.get('status'));
  const bucketSize = Math.max(0.001, parseNumberArg(args.get('bucket'), 0.02));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const prisma = new PrismaClient();
  try {
    const [stats] = await prisma.$queryRaw`
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
        ${status ? Prisma.sql`AND "routingStatus" = ${status}` : Prisma.empty}
    `;

    const count = Number(stats?.count || 0);
    console.log(`Window: ${describeFilters({ days, reason, status })}`);
    console.log(`Total rows: ${count}`);
    if (!count) {
      console.log('No rows match the filters.');
      return;
    }
    console.log('\nScore summary:');
    console.log(`min   ${formatNumber(stats.min)}`);
    console.log(`avg   ${formatNumber(stats.avg)}`);
    console.log(`p50   ${formatNumber(stats.p50)}`);
    console.log(`p75   ${formatNumber(stats.p75)}`);
    console.log(`p90   ${formatNumber(stats.p90)}`);
    console.log(`p95   ${formatNumber(stats.p95)}`);
    console.log(`p99   ${formatNumber(stats.p99)}`);
    console.log(`max   ${formatNumber(stats.max)}`);

    const histogram = await prisma.$queryRaw`
      SELECT
        FLOOR("routingScore" / ${bucketSize})::int AS bucket,
        COUNT(*)::int AS count
      FROM "Tweet"
      WHERE "tweetedAt" >= ${since}
        AND "routingScore" IS NOT NULL
        ${reason ? Prisma.sql`AND "routingReason" = ${reason}` : Prisma.empty}
        ${status ? Prisma.sql`AND "routingStatus" = ${status}` : Prisma.empty}
      GROUP BY bucket
      ORDER BY bucket
    `;

    console.log(`\nHistogram (bucket=${bucketSize}):`);
    for (const row of histogram) {
      const bucket = Number(row.bucket || 0);
      const bucketCount = Number(row.count || 0);
      const start = bucket * bucketSize;
      const end = start + bucketSize;
      const ratio = count ? bucketCount / count : 0;
      console.log(
        `${formatNumber(start, 3)} - ${formatNumber(end, 3)}  ${String(bucketCount).padStart(7)} (${formatPercent(ratio)})`
      );
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
        ${status ? Prisma.sql`AND "routingStatus" = ${status}` : Prisma.empty}
      GROUP BY tag
      ORDER BY count DESC
      LIMIT 15
    `;

    if (topTags.length) {
      console.log('\nTop tags (by count):');
      for (const row of topTags) {
        console.log(
          `${String(row.tag).padEnd(18)} ${String(row.count).padStart(7)} avg=${formatNumber(row.avg)}`
        );
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
