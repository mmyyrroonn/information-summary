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

function formatPercent(value) {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

async function main() {
  ensureDatabaseUrl();
  const args = parseArgs(process.argv);
  const days = Math.max(1, Math.floor(parseNumberArg(args.get('days'), 30)));
  const topN = Math.max(1, Math.floor(parseNumberArg(args.get('top'), 20)));
  const statusFilter = normalizeStatus(args.get('status'));
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

    const total = statusRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
    console.log(`Window: last ${days} days`);
    console.log(`Total tweets: ${total}`);
    console.log('\nRouting status distribution:');
    for (const row of statusRows) {
      const count = Number(row.count || 0);
      const ratio = total ? count / total : 0;
      console.log(`${String(row.status).padEnd(12)} ${String(count).padStart(7)} (${formatPercent(ratio)})`);
    }

    const reasonRows = await prisma.$queryRaw`
      SELECT
        COALESCE("routingReason", '(null)') AS reason,
        COUNT(*)::int AS count
      FROM "Tweet"
      WHERE "tweetedAt" >= ${since}
      ${statusFilter ? Prisma.sql`AND "routingStatus" = ${statusFilter}` : Prisma.empty}
      GROUP BY reason
      ORDER BY count DESC
      LIMIT ${topN}
    `;

    console.log(`\nTop routing reasons${statusFilter ? ` (status=${statusFilter})` : ''}:`);
    for (const row of reasonRows) {
      console.log(`${String(row.reason).padEnd(20)} ${String(row.count).padStart(7)}`);
    }

    const verdictRows = await prisma.$queryRaw`
      SELECT
        ti."verdict" AS verdict,
        COUNT(*)::int AS count
      FROM "TweetInsight" ti
      JOIN "Tweet" t ON t."tweetId" = ti."tweetId"
      WHERE t."tweetedAt" >= ${since}
      GROUP BY ti."verdict"
      ORDER BY count DESC
    `;

    if (verdictRows.length) {
      const verdictTotal = verdictRows.reduce((sum, row) => sum + Number(row.count || 0), 0);
      console.log('\nInsight verdict distribution:');
      for (const row of verdictRows) {
        const count = Number(row.count || 0);
        const ratio = verdictTotal ? count / verdictTotal : 0;
        console.log(`${String(row.verdict).padEnd(12)} ${String(count).padStart(7)} (${formatPercent(ratio)})`);
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
