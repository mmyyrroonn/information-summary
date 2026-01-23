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

function formatPercent(value) {
  if (!Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function makeCounter() {
  return { total: 0, high: 0 };
}

function addCount(counter, isHigh) {
  counter.total += 1;
  if (isHigh) counter.high += 1;
}

function bucketIndex(value, edges) {
  for (let i = 0; i < edges.length; i += 1) {
    if (value < edges[i]) return i;
  }
  return edges.length;
}

function ensureMapEntry(map, key) {
  if (!map.has(key)) map.set(key, makeCounter());
  return map.get(key);
}

const HIGH_SIGNAL_KEYWORDS = [
  'sec',
  'cftc',
  'fomc',
  'cpi',
  'pce',
  'etf',
  'blackrock',
  'grayscale',
  '监管',
  '合规',
  '加息',
  '降息',
  '利率',
  '稳定币',
  'hack',
  'exploit',
  '漏洞',
  '攻击',
  '被盗',
  '暂停',
  '修复',
  '融资',
  'funding',
  'round',
  'series',
  '估值',
  '并购',
  'acquisition',
  '回购',
  'buyback',
  '解锁',
  'unlock',
  '销毁',
  'burn',
  '主网',
  'mainnet',
  '升级',
  'hard fork',
  'testnet'
];

const LOW_SIGNAL_KEYWORDS = [
  '涨',
  '跌',
  '突破',
  '新高',
  '24h',
  '24小时',
  '上币',
  '上线',
  '交易对',
  'listing',
  'airdrop',
  '空投',
  '快照',
  'snapshot',
  '喊单',
  '爆仓'
];

const KEYWORDS = Array.from(new Set([...HIGH_SIGNAL_KEYWORDS, ...LOW_SIGNAL_KEYWORDS]));
const KEYWORD_MATCHERS = KEYWORDS.map((keyword) => ({ keyword, needle: keyword.toLowerCase() }));

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

async function main() {
  ensureDatabaseUrl();
  const args = parseArgs(process.argv);
  const days = Math.max(1, Math.floor(parseNumberArg(args.get('days'), 90)));
  const minImportance = Math.max(1, Math.floor(parseNumberArg(args.get('minImportance'), 4)));
  const limit = Math.max(0, Math.floor(parseNumberArg(args.get('limit'), 0)));
  const minKeywordCount = Math.max(1, Math.floor(parseNumberArg(args.get('minKeywordCount'), 10)));
  const keywordTopN = Math.max(1, Math.floor(parseNumberArg(args.get('keywordTopN'), 25)));

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const prisma = new PrismaClient();

  try {
    const limitClause = limit > 0 ? Prisma.sql`LIMIT ${limit}` : Prisma.empty;
    const rows = await prisma.$queryRaw`
      SELECT
        ti."importance" as "importance",
        encode(convert_to(t."text", 'SQL_ASCII'), 'base64') as "textB64",
        t."lang" as "lang"
      FROM "TweetInsight" ti
      JOIN "Tweet" t ON t."tweetId" = ti."tweetId"
      WHERE t."tweetedAt" >= ${since}
      ${limitClause}
    `;

    const total = rows.length;
    const totalHigh = rows.filter((item) => (item.importance ?? 0) >= minImportance).length;

    const featureStats = new Map();
    const lengthBuckets = ['<40', '40-79', '80-119', '120-159', '>=160'].map(() => makeCounter());
    const lengthEdges = [40, 80, 120, 160];
    const ratioBuckets = ['<1%', '1-3%', '3-6%', '>=6%'].map(() => makeCounter());
    const ratioEdges = [0.01, 0.03, 0.06];
    const numberBuckets = ['0', '1', '2', '>=3'].map(() => makeCounter());

    const keywordStats = new Map(KEYWORDS.map((keyword) => [keyword, makeCounter()]));
    const langStats = new Map();

    for (const item of rows) {
      const rawText =
        typeof item.textB64 === 'string' && item.textB64.length
          ? Buffer.from(item.textB64, 'base64').toString('utf8')
          : '';
      const cleaned = rawText.replace(/\s+/g, ' ').trim();
      const len = cleaned.length;
      const isHigh = (item.importance ?? 0) >= minImportance;

      const digitCount = (cleaned.match(/\d/g) || []).length;
      const numberTokens = (cleaned.match(/\d+(?:[.,]\d+)?%?/g) || []).length;
      const digitRatio = len ? digitCount / len : 0;

      const hasUrl = /https?:\/\/|www\./i.test(cleaned);
      const hasAddress = /0x[a-fA-F0-9]{40,64}/.test(cleaned);
      const hasTicker = /\$[a-z]{2,6}\b/i.test(cleaned);
      const hasAmountUnit =
        /(?:%|\b(?:usd|usdt|usdc|btc|eth|bnb|sol|m|b|k)\b|美元|美金|亿|万)/i.test(cleaned);
      const hasTimeUnit =
        /(?:\b(?:sec|second|minute|min|hour|day|week|month|year)s?\b|分钟|小时|天|周|月|年|UTC|GMT)/i.test(cleaned);

      const featureChecks = [
        ['len>=40', len >= 40],
        ['len>=80', len >= 80],
        ['len>=120', len >= 120],
        ['numberTokens>=1', numberTokens >= 1],
        ['numberTokens>=2', numberTokens >= 2],
        ['digitRatio>=1%', digitRatio >= 0.01],
        ['digitRatio>=3%', digitRatio >= 0.03],
        ['digitRatio>=6%', digitRatio >= 0.06],
        ['hasAmountUnit', hasAmountUnit],
        ['hasTimeUnit', hasTimeUnit],
        ['hasAddress', hasAddress],
        ['hasUrl', hasUrl],
        ['hasTicker', hasTicker]
      ];

      for (const [name, passed] of featureChecks) {
        if (!passed) continue;
        const counter = ensureMapEntry(featureStats, name);
        addCount(counter, isHigh);
      }

      addCount(lengthBuckets[bucketIndex(len, lengthEdges)], isHigh);
      addCount(ratioBuckets[bucketIndex(digitRatio, ratioEdges)], isHigh);
      if (numberTokens === 0) addCount(numberBuckets[0], isHigh);
      else if (numberTokens === 1) addCount(numberBuckets[1], isHigh);
      else if (numberTokens === 2) addCount(numberBuckets[2], isHigh);
      else addCount(numberBuckets[3], isHigh);

      const lower = cleaned.toLowerCase();
      let hitHighKeyword = false;
      let hitLowKeyword = false;
      for (const matcher of KEYWORD_MATCHERS) {
        if (!lower.includes(matcher.needle)) continue;
        const counter = keywordStats.get(matcher.keyword);
        if (counter) addCount(counter, isHigh);
        if (HIGH_SIGNAL_KEYWORDS.includes(matcher.keyword)) hitHighKeyword = true;
        if (LOW_SIGNAL_KEYWORDS.includes(matcher.keyword)) hitLowKeyword = true;
      }

      if (hitHighKeyword) addCount(ensureMapEntry(featureStats, 'hasHighSignalKeyword'), isHigh);
      if (hitLowKeyword) addCount(ensureMapEntry(featureStats, 'hasLowSignalKeyword'), isHigh);

      const lang = item.lang || 'unknown';
      addCount(ensureMapEntry(langStats, lang), isHigh);
    }

    console.log(`Window: last ${days} days`);
    console.log(`Records: ${total}, high(importance>=${minImportance}): ${totalHigh}`);
    console.log(`High ratio: ${formatPercent(totalHigh / Math.max(total, 1))}\n`);

    const featureRows = Array.from(featureStats.entries()).map(([name, counter]) => ({
      name,
      total: counter.total,
      high: counter.high,
      precision: counter.high / Math.max(counter.total, 1),
      recall: counter.high / Math.max(totalHigh, 1)
    }));

    featureRows.sort((a, b) => b.precision - a.precision);
    console.log('Feature precision/recall (sorted by precision):');
    for (const row of featureRows) {
      console.log(
        `${row.name.padEnd(24)} total=${row.total.toString().padStart(6)} high=${row.high.toString().padStart(6)} precision=${formatPercent(row.precision)} recall=${formatPercent(row.recall)}`
      );
    }

    function printBuckets(title, labels, counters) {
      console.log(`\n${title}`);
      labels.forEach((label, idx) => {
        const counter = counters[idx];
        const precision = counter.high / Math.max(counter.total, 1);
        const recall = counter.high / Math.max(totalHigh, 1);
        console.log(
          `${label.padEnd(8)} total=${counter.total.toString().padStart(6)} high=${counter.high.toString().padStart(6)} precision=${formatPercent(precision)} recall=${formatPercent(recall)}`
        );
      });
    }

    printBuckets('Length buckets', ['<40', '40-79', '80-119', '120-159', '>=160'], lengthBuckets);
    printBuckets('Digit ratio buckets', ['<1%', '1-3%', '3-6%', '>=6%'], ratioBuckets);
    printBuckets('Number token buckets', ['0', '1', '2', '>=3'], numberBuckets);

    const keywordRows = Array.from(keywordStats.entries())
      .filter(([, counter]) => counter.total >= minKeywordCount)
      .map(([keyword, counter]) => ({
        keyword,
        total: counter.total,
        high: counter.high,
        precision: counter.high / Math.max(counter.total, 1),
        recall: counter.high / Math.max(totalHigh, 1)
      }));

    keywordRows.sort((a, b) => b.precision - a.precision);
    console.log(`\nTop keywords by precision (min count ${minKeywordCount}):`);
    for (const row of keywordRows.slice(0, keywordTopN)) {
      console.log(
        `${row.keyword.padEnd(14)} total=${row.total.toString().padStart(6)} high=${row.high.toString().padStart(6)} precision=${formatPercent(row.precision)} recall=${formatPercent(row.recall)}`
      );
    }

    keywordRows.sort((a, b) => b.recall - a.recall);
    console.log(`\nTop keywords by recall (min count ${minKeywordCount}):`);
    for (const row of keywordRows.slice(0, keywordTopN)) {
      console.log(
        `${row.keyword.padEnd(14)} total=${row.total.toString().padStart(6)} high=${row.high.toString().padStart(6)} precision=${formatPercent(row.precision)} recall=${formatPercent(row.recall)}`
      );
    }

    const langRows = Array.from(langStats.entries()).map(([lang, counter]) => ({
      lang,
      total: counter.total,
      high: counter.high,
      precision: counter.high / Math.max(counter.total, 1)
    }));
    langRows.sort((a, b) => b.total - a.total);
    console.log('\nLanguage stats (by volume):');
    for (const row of langRows) {
      console.log(
        `${row.lang.padEnd(8)} total=${row.total.toString().padStart(6)} high=${row.high.toString().padStart(6)} precision=${formatPercent(row.precision)}`
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
