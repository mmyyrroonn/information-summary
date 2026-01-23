import { Prisma, Tweet } from '@prisma/client';
import { prisma } from '../../db';
import { config } from '../../config';
import { logger } from '../../logger';
import { chunk } from '../../utils/chunk';
import { createEmbeddings, embeddingsEnabled } from '../embeddingService';
import { HIGH_PRIORITY_IMPORTANCE, truncateText } from './shared';

const EMBEDDING_BATCH_SIZE = 10;
const EMBEDDING_TEXT_MAX_LENGTH = 320;
const ROUTING_CACHE_ID = 'routing-cache';
const ROUTE_EMBEDDING_SAMPLE_WINDOW_DAYS = 120;
const ROUTE_EMBEDDING_POS_SAMPLE = 180;
const ROUTE_EMBEDDING_NEG_SAMPLE = 360;
const ROUTE_EMBEDDING_MIN_SAMPLE = 40;
const ROUTE_EMBEDDING_DROP_SIM = 0.88;
const ROUTE_EMBEDDING_DROP_MARGIN = 0.04;
const RULE_MIN_LEN = 80;
const RULE_LONG_LEN = 160;
const RULE_LONG_MIN_NUMBER_TOKENS = 3;
const RULE_TICKER_MIN_NUMBER_TOKENS = 2;
const RULE_LOW_VALUE_LANGS = new Set(['zxx', 'und', 'qme', 'qst', 'qam', 'qct', 'qht']);
const RULE_HIGH_SIGNAL_KEYWORDS = [
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
const RULE_HIGH_SIGNAL_NEEDLES = RULE_HIGH_SIGNAL_KEYWORDS.map((keyword) => keyword.toLowerCase());

type RoutingSampleRow = { tweetId: string; textB64: string | null };

type RoutingCache = {
  updatedAtMs: number;
  model: string;
  dimensions: number;
  positives: number[][];
  negatives: number[][];
};

let routingCache: RoutingCache | null = null;

function normalizeVector(vector: number[]) {
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

function dot(a: number[], b: number[]) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function parseVectorMatrix(value: Prisma.JsonValue, dimensions: number) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!Array.isArray(entry)) return null;
      const vector = entry.map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : 0));
      if (dimensions > 0 && vector.length !== dimensions) return null;
      return vector;
    })
    .filter((entry): entry is number[] => Array.isArray(entry));
}

function normalizeTweetText(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function countNumberTokens(text: string) {
  return (text.match(/\d+(?:[.,]\d+)?%?/g) ?? []).length;
}

function hasHighSignalKeyword(textLower: string) {
  return RULE_HIGH_SIGNAL_NEEDLES.some((needle) => textLower.includes(needle));
}

function hasAmountUnit(text: string) {
  return /(?:%|\b(?:usd|usdt|usdc|btc|eth|bnb|sol|m|b|k)\b|美元|美金|亿|万)/i.test(text);
}

function hasTimeUnit(text: string) {
  return /(?:\b(?:sec|second|minute|min|hour|day|week|month|year)s?\b|分钟|小时|天|周|月|年|UTC|GMT)/i.test(text);
}

function hasTicker(text: string) {
  return /\$[a-z]{2,6}\b/i.test(text);
}

function buildRoutingEmbeddingText(tweet: Tweet) {
  const cleaned = normalizeTweetText(tweet.text);
  return truncateText(cleaned, EMBEDDING_TEXT_MAX_LENGTH);
}

function decodeBase64Text(value: string | null) {
  if (!value) return '';
  return Buffer.from(value, 'base64').toString('utf8');
}

async function embedTexts(texts: string[]) {
  if (!texts.length) return [];
  const batches = chunk(texts, EMBEDDING_BATCH_SIZE);
  const results: number[][] = [];
  for (const batch of batches) {
    const vectors = await createEmbeddings(batch);
    if (vectors.length !== batch.length) {
      throw new Error(`Embedding batch size mismatch: expected ${batch.length}, got ${vectors.length}`);
    }
    results.push(...vectors);
  }
  return results;
}

async function loadRoutingSamples(limit: number, whereSql: Prisma.Sql, since: Date) {
  const limitClause = limit > 0 ? Prisma.sql`LIMIT ${limit}` : Prisma.empty;
  const rows = await prisma.$queryRaw<RoutingSampleRow[]>`
    SELECT
      t."tweetId" as "tweetId",
      encode(convert_to(t."text", 'SQL_ASCII'), 'base64') as "textB64"
    FROM "TweetInsight" ti
    JOIN "Tweet" t ON t."tweetId" = ti."tweetId"
    WHERE t."tweetedAt" >= ${since}
      AND ${whereSql}
    ORDER BY t."tweetedAt" DESC
    ${limitClause}
  `;
  return rows;
}

async function buildRoutingEmbeddingCacheData() {
  if (!embeddingsEnabled()) {
    logger.warn('Embeddings disabled, skip routing cache build');
    return null;
  }
  const model = config.EMBEDDING_MODEL;
  const dimensions = config.EMBEDDING_DIMENSIONS;
  const since = new Date(Date.now() - ROUTE_EMBEDDING_SAMPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [positiveRows, negativeRows] = await Promise.all([
    loadRoutingSamples(
      ROUTE_EMBEDDING_POS_SAMPLE,
      Prisma.sql`ti."importance" >= ${HIGH_PRIORITY_IMPORTANCE}`,
      since
    ),
    loadRoutingSamples(
      ROUTE_EMBEDDING_NEG_SAMPLE,
      Prisma.sql`(ti."importance" IS NOT NULL AND ti."importance" <= 2) OR ti."verdict" = 'ignore'`,
      since
    )
  ]);

  const positiveTexts = positiveRows
    .map((row) => truncateText(normalizeTweetText(decodeBase64Text(row.textB64)), EMBEDDING_TEXT_MAX_LENGTH))
    .filter((text) => text.length > 0);
  const negativeTexts = negativeRows
    .map((row) => truncateText(normalizeTweetText(decodeBase64Text(row.textB64)), EMBEDDING_TEXT_MAX_LENGTH))
    .filter((text) => text.length > 0);

  if (positiveTexts.length < ROUTE_EMBEDDING_MIN_SAMPLE || negativeTexts.length < ROUTE_EMBEDDING_MIN_SAMPLE) {
    logger.warn('Routing embedding samples insufficient, skip routing', {
      positive: positiveTexts.length,
      negative: negativeTexts.length
    });
    return null;
  }

  logger.info('Building routing embedding samples', {
    positives: positiveTexts.length,
    negatives: negativeTexts.length,
    model,
    dimensions
  });

  const [positiveVectors, negativeVectors] = await Promise.all([
    embedTexts(positiveTexts),
    embedTexts(negativeTexts)
  ]);

  return {
    model,
    dimensions,
    positives: positiveVectors.map((vector) => normalizeVector(vector)),
    negatives: negativeVectors.map((vector) => normalizeVector(vector))
  };
}

async function persistRoutingEmbeddingCache(data: {
  model: string;
  dimensions: number;
  positives: number[][];
  negatives: number[][];
}) {
  const record = await prisma.routingEmbeddingCache.upsert({
    where: { id: ROUTING_CACHE_ID },
    update: {
      model: data.model,
      dimensions: data.dimensions,
      positives: data.positives,
      negatives: data.negatives,
      positiveCount: data.positives.length,
      negativeCount: data.negatives.length,
      sourceWindowDays: ROUTE_EMBEDDING_SAMPLE_WINDOW_DAYS
    },
    create: {
      id: ROUTING_CACHE_ID,
      model: data.model,
      dimensions: data.dimensions,
      positives: data.positives,
      negatives: data.negatives,
      positiveCount: data.positives.length,
      negativeCount: data.negatives.length,
      sourceWindowDays: ROUTE_EMBEDDING_SAMPLE_WINDOW_DAYS
    }
  });

  routingCache = {
    updatedAtMs: record.updatedAt.getTime(),
    model: record.model,
    dimensions: record.dimensions,
    positives: data.positives,
    negatives: data.negatives
  };

  return routingCache;
}

export async function refreshRoutingEmbeddingCache(reason = 'manual') {
  if (!embeddingsEnabled()) {
    return { updated: false, reason: 'embeddings-disabled' };
  }
  const data = await buildRoutingEmbeddingCacheData();
  if (!data) {
    return { updated: false, reason: 'insufficient-samples' };
  }
  const cache = await persistRoutingEmbeddingCache(data);
  logger.info('Routing embedding cache refreshed', {
    reason,
    positives: cache.positives.length,
    negatives: cache.negatives.length,
    model: cache.model,
    dimensions: cache.dimensions
  });
  return {
    updated: true,
    positives: cache.positives.length,
    negatives: cache.negatives.length,
    model: cache.model,
    dimensions: cache.dimensions,
    updatedAt: new Date(cache.updatedAtMs).toISOString()
  };
}

async function loadRoutingEmbeddingCache() {
  if (!embeddingsEnabled()) return null;
  const record = await prisma.routingEmbeddingCache.findUnique({ where: { id: ROUTING_CACHE_ID } });
  if (!record) {
    logger.info('Routing embedding cache missing, building');
    const data = await buildRoutingEmbeddingCacheData();
    if (!data) return null;
    return persistRoutingEmbeddingCache(data);
  }

  const updatedAtMs = record.updatedAt.getTime();
  if (
    routingCache &&
    routingCache.updatedAtMs === updatedAtMs &&
    routingCache.model === record.model &&
    routingCache.dimensions === record.dimensions
  ) {
    return routingCache;
  }

  if (record.model !== config.EMBEDDING_MODEL || record.dimensions !== config.EMBEDDING_DIMENSIONS) {
    logger.warn('Routing embedding cache model mismatch, rebuilding', {
      storedModel: record.model,
      storedDimensions: record.dimensions,
      currentModel: config.EMBEDDING_MODEL,
      currentDimensions: config.EMBEDDING_DIMENSIONS
    });
    const data = await buildRoutingEmbeddingCacheData();
    if (!data) return null;
    return persistRoutingEmbeddingCache(data);
  }

  const positives = parseVectorMatrix(record.positives, record.dimensions);
  const negatives = parseVectorMatrix(record.negatives, record.dimensions);
  if (positives.length < ROUTE_EMBEDDING_MIN_SAMPLE || negatives.length < ROUTE_EMBEDDING_MIN_SAMPLE) {
    logger.warn('Routing embedding cache insufficient, rebuilding', {
      positives: positives.length,
      negatives: negatives.length
    });
    const data = await buildRoutingEmbeddingCacheData();
    if (!data) return null;
    return persistRoutingEmbeddingCache(data);
  }

  routingCache = {
    updatedAtMs,
    model: record.model,
    dimensions: record.dimensions,
    positives,
    negatives
  };

  return routingCache;
}

export async function applyEmbeddingRouting(tweets: Tweet[]) {
  if (!tweets.length) {
    return { analyze: [], ignored: [], reasonCounts: new Map<string, number>() };
  }
  if (!embeddingsEnabled()) {
    return { analyze: tweets, ignored: [], reasonCounts: new Map<string, number>() };
  }

  try {
    const cache = await loadRoutingEmbeddingCache();
    if (!cache) {
      return { analyze: tweets, ignored: [], reasonCounts: new Map<string, number>() };
    }

    const texts = tweets.map((tweet) => buildRoutingEmbeddingText(tweet));
    const vectors = await embedTexts(texts);
    if (vectors.length !== tweets.length) {
      logger.warn('Routing embedding size mismatch, skip routing', {
        expected: tweets.length,
        actual: vectors.length
      });
      return { analyze: tweets, ignored: [], reasonCounts: new Map<string, number>() };
    }

    const reasonCounts = new Map<string, number>();
    const analyze: Tweet[] = [];
    const ignored: Array<{ tweet: Tweet; reason: string }> = [];

    const bumpReason = (reason: string) => {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    };

    vectors.forEach((vector, index) => {
      const normalized = normalizeVector(vector);
      let maxPos = -1;
      for (const sample of cache.positives) {
        const score = dot(normalized, sample);
        if (score > maxPos) maxPos = score;
      }
      let maxNeg = -1;
      for (const sample of cache.negatives) {
        const score = dot(normalized, sample);
        if (score > maxNeg) maxNeg = score;
      }

      const tweet = tweets[index];
      if (maxNeg >= ROUTE_EMBEDDING_DROP_SIM && maxNeg - maxPos >= ROUTE_EMBEDDING_DROP_MARGIN) {
        ignored.push({ tweet, reason: 'embed-drop' });
        bumpReason('embed-drop');
        return;
      }

      analyze.push(tweet);
      bumpReason('embed-keep');
    });

    logger.info('Embedding routing completed', {
      candidates: tweets.length,
      analyze: analyze.length,
      ignored: ignored.length,
      reasons: Object.fromEntries(reasonCounts)
    });

    return { analyze, ignored, reasonCounts };
  } catch (error) {
    logger.warn('Embedding routing failed, fallback to full analysis', {
      error: error instanceof Error ? error.message : String(error)
    });
    return { analyze: tweets, ignored: [], reasonCounts: new Map<string, number>() };
  }
}

export function applyRuleBasedRouting(tweets: Tweet[]) {
  const analyze: Tweet[] = [];
  const ignored: Array<{ tweet: Tweet; reason: string }> = [];
  const reasonCounts = new Map<string, number>();

  const bumpReason = (reason: string) => {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  };

  for (const tweet of tweets) {
    const cleaned = normalizeTweetText(tweet.text);
    const lower = cleaned.toLowerCase();
    const len = cleaned.length;
    const numberTokens = countNumberTokens(cleaned);
    const highSignal = hasHighSignalKeyword(lower);
    const amountUnit = hasAmountUnit(cleaned);
    const timeUnit = hasTimeUnit(cleaned);
    const ticker = hasTicker(cleaned);
    const lowLang = RULE_LOW_VALUE_LANGS.has((tweet.lang ?? '').trim().toLowerCase());

    const shouldAnalyze =
      highSignal ||
      (amountUnit && timeUnit) ||
      (len >= RULE_LONG_LEN && numberTokens >= RULE_LONG_MIN_NUMBER_TOKENS) ||
      (ticker && numberTokens >= RULE_TICKER_MIN_NUMBER_TOKENS);

    if (lowLang && !shouldAnalyze) {
      ignored.push({ tweet, reason: 'low-lang' });
      bumpReason('low-lang');
      continue;
    }

    const lowInfoShort = len < RULE_MIN_LEN && numberTokens <= 1 && !highSignal && !amountUnit && !timeUnit;
    if (!shouldAnalyze && lowInfoShort) {
      ignored.push({ tweet, reason: 'low-info-short' });
      bumpReason('low-info-short');
      continue;
    }

    if (!shouldAnalyze) {
      ignored.push({ tweet, reason: 'rule-drop' });
      bumpReason('rule-drop');
      continue;
    }

    analyze.push(tweet);
    bumpReason('rule-keep');
  }

  return {
    analyze,
    ignored,
    reasonCounts
  };
}
