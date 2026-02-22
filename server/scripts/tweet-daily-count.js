/* eslint-disable no-console */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config();
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
}

const { PrismaClient } = require('@prisma/client');

function parseArgs(argv) {
  const args = new Map();
  for (const part of argv.slice(2)) {
    if (!part.startsWith('--')) continue;
    const [key, rawValue] = part.slice(2).split('=');
    args.set(key, rawValue ?? true);
  }
  return args;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.floor(num));
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

function pad(value, width) {
  const str = String(value);
  return str.length >= width ? str : `${' '.repeat(width - str.length)}${str}`;
}

async function main() {
  ensureDatabaseUrl();

  const args = parseArgs(process.argv);
  const days = parsePositiveInt(args.get('days'), 30);
  const tz = typeof args.get('tz') === 'string' ? args.get('tz') : 'UTC';
  const json = args.has('json');

  const prisma = new PrismaClient();

  try {
    const rows = await prisma.$queryRaw`
      WITH bounds AS (
        SELECT
          (timezone(${tz}, now())::date - (${days} - 1) * INTERVAL '1 day')::date AS start_day,
          timezone(${tz}, now())::date AS end_day
      ),
      day_series AS (
        SELECT generate_series(b.start_day, b.end_day, INTERVAL '1 day')::date AS day_local
        FROM bounds b
      ),
      tweet_counts AS (
        SELECT
          timezone(${tz}, t."tweetedAt")::date AS day_local,
          COUNT(*)::bigint AS count
        FROM "Tweet" t
        CROSS JOIN bounds b
        WHERE timezone(${tz}, t."tweetedAt")::date BETWEEN b.start_day AND b.end_day
        GROUP BY 1
      )
      SELECT
        to_char(d.day_local, 'YYYY-MM-DD') AS day,
        COALESCE(tc.count, 0)::bigint AS count
      FROM day_series d
      LEFT JOIN tweet_counts tc ON tc.day_local = d.day_local
      ORDER BY d.day_local;
    `;

    const normalized = rows.map((row) => ({
      day: row.day,
      count: Number(row.count ?? 0)
    }));

    if (json) {
      console.log(JSON.stringify({ days, tz, data: normalized }, null, 2));
      return;
    }

    const countWidth = Math.max(5, ...normalized.map((item) => String(item.count).length));
    const total = normalized.reduce((sum, item) => sum + item.count, 0);

    console.log(`Tweet daily counts (last ${days} days, tz=${tz})`);
    console.log(`${'Date'.padEnd(10)}  ${'Count'.padStart(countWidth)}`);
    console.log(`${'-'.repeat(10)}  ${'-'.repeat(countWidth)}`);
    for (const item of normalized) {
      console.log(`${item.day}  ${pad(item.count, countWidth)}`);
    }
    console.log(`${'-'.repeat(10)}  ${'-'.repeat(countWidth)}`);
    console.log(`${'Total'.padEnd(10)}  ${pad(total, countWidth)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Failed to count tweets by day:', error?.message || error);
  process.exit(1);
});
