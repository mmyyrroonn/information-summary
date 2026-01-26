import { Prisma, Tweet } from '@prisma/client';
import { prisma } from '../../db';
import { config } from '../../config';
import { logger } from '../../logger';
import { chunk } from '../../utils/chunk';
import { createEmbeddings, embeddingsEnabled, hashEmbeddingText } from '../embeddingService';
import {
  CLASSIFY_ALLOWED_TAGS,
  HIGH_PRIORITY_IMPORTANCE,
  TAG_FALLBACK_KEY,
  truncateText,
  normalizeTagAlias
} from './shared';

const EMBEDDING_BATCH_SIZE = 10;
const EMBEDDING_TEXT_MAX_LENGTH = 320;
const ROUTING_TAG_CACHE_ID = 'routing-tag-cache';
const ROUTE_EMBEDDING_SAMPLE_WINDOW_DAYS = 120;
const ROUTE_EMBEDDING_SAMPLE_PER_TAG = 200;
const ROUTE_EMBEDDING_MIN_SAMPLE = 40;
const ROUTE_EMBEDDING_MIN_PRIMARY_SAMPLE = 100;
const ROUTE_EMBEDDING_NEG_SAMPLE = 300;
const ROUTE_EMBEDDING_NEG_MIN_SAMPLE = 80;
const ROUTE_NEGATIVE_IMPORTANCE_MAX = 1;
const ROUTE_CLASSIFY_HIGH_SIM = 0.86;
const ROUTE_CLASSIFY_HIGH_STRICT = 0.9;
const ROUTE_CLASSIFY_HIGH_MARGIN = 0.04;
const ROUTE_CLASSIFY_LOW_SIM = 0.72;
const ROUTE_CLASSIFY_NEG_GAP_LOW = 0.05;
const ROUTE_CLASSIFY_NEG_GAP_HIGH = 0.08;
const ROUTE_TAG_SCORE_TOP_K = 5;
const ROUTING_UNASSIGNED_TAG = '__unrouted__';
const ROUTING_NEGATIVE_KEY = '__low_quality__';
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

const ROUTING_TAGS = CLASSIFY_ALLOWED_TAGS.filter((tag) => tag !== TAG_FALLBACK_KEY);

type RoutingRefreshOptions = {
  windowDays?: number;
  samplePerTag?: number;
};

type RoutingRefreshParams = {
  windowDays: number;
  samplePerTag: number;
};

type TagCacheRecord = {
  updatedAtMs: number;
  model: string;
  dimensions: number;
  windowDays: number;
  samplePerTag: number;
  tagSamples: Record<string, number[][]>;
  tagSampleCounts: Record<string, number>;
  tagCentroids: Record<string, number[]>;
  tagStats: Record<string, TagScoreStats>;
  tagThresholds: Record<string, TagThresholds>;
  negativeCentroid: number[] | null;
  negativeSampleCount: number;
};

type TagRoutingResult = {
  analyzeByTag: Map<string, Tweet[]>;
  ignored: Array<{ tweet: Tweet; reason: string }>;
  autoHigh: Array<{ tweet: Tweet; reason: string; tag: string; score: number; importance: number }>;
  decisions: Map<string, TagRoutingDecision>;
  reasonCounts: Map<string, number>;
};

type TagRoutingDecision = {
  status: 'analyze' | 'ignored' | 'auto-high';
  tag?: string;
  score?: number;
  margin?: number;
  negativeScore?: number;
  negativeGap?: number;
  reason: string;
  importance?: number;
};

type TagScoreStats = {
  mean: number;
  min: number;
  max: number;
  p25: number;
  p50: number;
  p75: number;
  sampleCount: number;
};

type TagThresholds = {
  lowSim: number;
  highSim: number;
  highStrict: number;
  highMargin: number;
  negGapLow: number;
  negGapHigh: number;
};

type EmbeddingCandidate = { tweetId: string; text: string };

type TagSample = {
  tweetId: string;
  text: string;
};

let routingTagCache: TagCacheRecord | null = null;

const DEFAULT_TAG_THRESHOLDS: TagThresholds = {
  lowSim: ROUTE_CLASSIFY_LOW_SIM,
  highSim: ROUTE_CLASSIFY_HIGH_SIM,
  highStrict: ROUTE_CLASSIFY_HIGH_STRICT,
  highMargin: ROUTE_CLASSIFY_HIGH_MARGIN,
  negGapLow: ROUTE_CLASSIFY_NEG_GAP_LOW,
  negGapHigh: ROUTE_CLASSIFY_NEG_GAP_HIGH
};

const TAG_THRESHOLD_OVERRIDES: Partial<Record<string, Partial<TagThresholds>>> = {};

function toPositiveInt(value: number | undefined, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const intValue = Math.floor(value);
  return intValue > 0 ? intValue : fallback;
}

function normalizeRoutingRefreshOptions(options?: RoutingRefreshOptions): RoutingRefreshParams {
  return {
    windowDays: toPositiveInt(options?.windowDays, ROUTE_EMBEDDING_SAMPLE_WINDOW_DAYS),
    samplePerTag: toPositiveInt(options?.samplePerTag, ROUTE_EMBEDDING_SAMPLE_PER_TAG)
  };
}

function resolveTagThresholds(tag: string, stats?: TagScoreStats): TagThresholds {
  const override = TAG_THRESHOLD_OVERRIDES[tag] ?? {};
  const thresholds: TagThresholds = { ...DEFAULT_TAG_THRESHOLDS, ...override };
  if (!stats || stats.sampleCount < 10) {
    return thresholds;
  }

  const lowSim = (thresholds.lowSim + stats.p25) / 2;
  const highSim = (thresholds.highSim + stats.p75) / 2;
  thresholds.lowSim = clamp(lowSim, thresholds.lowSim - 0.05, thresholds.lowSim + 0.05);
  thresholds.highSim = clamp(highSim, thresholds.highSim - 0.05, thresholds.highSim + 0.05);
  thresholds.highMargin = clamp(
    thresholds.highMargin + (stats.p75 - stats.p50 < 0.02 ? 0.01 : 0),
    0.03,
    0.08
  );
  thresholds.highStrict = Math.max(thresholds.highStrict, thresholds.highSim + 0.02);

  if (thresholds.lowSim >= thresholds.highSim - 0.02) {
    thresholds.lowSim = clamp(thresholds.highSim - 0.02, 0.5, thresholds.highSim - 0.01);
  }

  return thresholds;
}

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

function clamp(value: number, min: number, max: number) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function sumInto(acc: number[], v: number[]) {
  const n = Math.max(acc.length, v.length);
  for (let i = 0; i < n; i += 1) {
    acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
  }
  return acc;
}

function buildCentroid(samples: number[][], dimensions: number) {
  if (!samples.length) return Array.from({ length: dimensions }, () => 0);
  const sum = Array.from({ length: dimensions }, () => 0);
  samples.forEach((vector) => sumInto(sum, vector));
  return normalizeVector(sum);
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const clamped = clamp(q, 0, 1);
  const index = Math.floor((sorted.length - 1) * clamped);
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
}

function computeTagStats(samples: number[][], centroid: number[]): TagScoreStats {
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

function topKMeanScore(vector: number[], samples: number[][], k: number) {
  if (!samples.length) return -1;
  const top: number[] = [];
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

function parseTagSamples(value: Prisma.JsonValue, dimensions: number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const parsed: Record<string, number[][]> = {};
  Object.entries(record).forEach(([tag, entry]) => {
    if (!Array.isArray(entry)) return;
    const vectors = entry
      .map((vector) => {
        if (!Array.isArray(vector)) return null;
        const cleaned = vector.map((item) => (typeof item === 'number' && Number.isFinite(item) ? item : 0));
        if (dimensions > 0 && cleaned.length !== dimensions) return null;
        return normalizeVector(cleaned);
      })
      .filter((item): item is number[] => Array.isArray(item));
    if (vectors.length) {
      parsed[tag] = vectors;
    }
  });
  return parsed;
}

function parseTagSampleCounts(value: Prisma.JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const parsed: Record<string, number> = {};
  Object.entries(record).forEach(([tag, count]) => {
    if (typeof count === 'number' && Number.isFinite(count)) {
      parsed[tag] = Math.max(0, Math.floor(count));
    }
  });
  return parsed;
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

function buildTweetEmbeddingText(raw: string) {
  const cleaned = normalizeTweetText(raw);
  return truncateText(cleaned, EMBEDDING_TEXT_MAX_LENGTH);
}

async function ensureTweetEmbeddings(candidates: EmbeddingCandidate[]) {
  const unique = new Map<string, EmbeddingCandidate>();
  candidates.forEach((candidate) => {
    if (!candidate.tweetId) return;
    unique.set(candidate.tweetId, candidate);
  });
  const items = Array.from(unique.values());
  if (!items.length) return new Map<string, number[]>();
  if (!embeddingsEnabled()) return new Map<string, number[]>();

  const model = config.EMBEDDING_MODEL;
  const dimensions = config.EMBEDDING_DIMENSIONS;
  const now = new Date();
  const textPayload = items.map((item) => {
    const text = buildTweetEmbeddingText(item.text);
    return {
      tweetId: item.tweetId,
      text,
      textHash: hashEmbeddingText(text)
    };
  });

  const existing = await prisma.tweetEmbedding.findMany({
    where: { tweetId: { in: textPayload.map((item) => item.tweetId) } }
  });
  const existingById = new Map(existing.map((item) => [item.tweetId, item]));
  const freshEmbeddings = new Map<string, number[]>();
  const missing: Array<{ tweetId: string; text: string; textHash: string }> = [];

  textPayload.forEach((item) => {
    const record = existingById.get(item.tweetId);
    const hasVector = Array.isArray(record?.embedding) && record.embedding.length === dimensions;
    const isFresh =
      hasVector &&
      record?.model === model &&
      record?.dimensions === dimensions &&
      record?.textHash === item.textHash;
    if (isFresh && record?.embedding) {
      freshEmbeddings.set(item.tweetId, record.embedding);
    } else {
      missing.push(item);
    }
  });

  if (!missing.length) {
    return freshEmbeddings;
  }

  const batches = chunk(missing, EMBEDDING_BATCH_SIZE);
  for (const batch of batches) {
    const vectors = await createEmbeddings(batch.map((item) => item.text));
    if (vectors.length !== batch.length) {
      throw new Error(`Embedding batch size mismatch: expected ${batch.length}, got ${vectors.length}`);
    }
    await prisma.$transaction(
      batch.map((item, index) =>
        prisma.tweetEmbedding.upsert({
          where: { tweetId: item.tweetId },
          update: {
            embedding: vectors[index] ?? [],
            model,
            dimensions,
            textHash: item.textHash,
            embeddedAt: now
          },
          create: {
            tweetId: item.tweetId,
            embedding: vectors[index] ?? [],
            model,
            dimensions,
            textHash: item.textHash,
            embeddedAt: now
          }
        })
      )
    );
    batch.forEach((item, index) => {
      freshEmbeddings.set(item.tweetId, vectors[index] ?? []);
    });
  }

  return freshEmbeddings;
}

function resolveTagCandidates(tag: string) {
  const normalized = normalizeTagAlias(tag);
  const candidates = new Set<string>();
  candidates.add(normalized);
  if (normalized === 'macro') {
    candidates.add('market');
  }
  if (normalized === TAG_FALLBACK_KEY) {
    candidates.add('others');
  }
  return Array.from(candidates);
}

async function loadTagSamples(tag: string, params: RoutingRefreshParams): Promise<TagSample[]> {
  const since = new Date(Date.now() - params.windowDays * 24 * 60 * 60 * 1000);
  const tagCandidates = resolveTagCandidates(tag);
  const primary = await prisma.tweetInsight.findMany({
    where: {
      createdAt: { gte: since },
      importance: { gte: HIGH_PRIORITY_IMPORTANCE },
      verdict: { not: 'ignore' },
      tags: { hasSome: tagCandidates }
    },
    select: {
      tweetId: true,
      tweet: { select: { text: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: params.samplePerTag
  });

  if (primary.length >= ROUTE_EMBEDDING_MIN_PRIMARY_SAMPLE) {
    return primary.map((item) => ({ tweetId: item.tweetId, text: item.tweet.text }));
  }

  const supplementalLimit = params.samplePerTag - primary.length;
  if (supplementalLimit <= 0) {
    return primary.map((item) => ({ tweetId: item.tweetId, text: item.tweet.text }));
  }

  const supplemental = await prisma.tweetInsight.findMany({
    where: {
      createdAt: { gte: since },
      importance: 3,
      verdict: { not: 'ignore' },
      tags: { hasSome: tagCandidates },
      tweetId: primary.length ? { notIn: primary.map((item) => item.tweetId) } : undefined
    },
    select: {
      tweetId: true,
      tweet: { select: { text: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: supplementalLimit
  });

  return [...primary, ...supplemental].map((item) => ({ tweetId: item.tweetId, text: item.tweet.text }));
}

async function loadNegativeSamples(params: RoutingRefreshParams): Promise<TagSample[]> {
  const since = new Date(Date.now() - params.windowDays * 24 * 60 * 60 * 1000);
  const candidates = await prisma.tweetInsight.findMany({
    where: {
      createdAt: { gte: since },
      OR: [{ verdict: 'ignore' }, { importance: { lte: ROUTE_NEGATIVE_IMPORTANCE_MAX } }]
    },
    select: {
      tweetId: true,
      tweet: { select: { text: true } }
    },
    orderBy: { createdAt: 'desc' },
    take: ROUTE_EMBEDDING_NEG_SAMPLE
  });

  return candidates.map((item) => ({ tweetId: item.tweetId, text: item.tweet.text }));
}

async function buildTagEmbeddingCacheData(params: RoutingRefreshParams) {
  if (!embeddingsEnabled()) {
    logger.warn('Embeddings disabled, skip tag routing cache build');
    return null;
  }
  const model = config.EMBEDDING_MODEL;
  const dimensions = config.EMBEDDING_DIMENSIONS;
  const tagSamples: Record<string, number[][]> = {};
  const tagSampleCounts: Record<string, number> = {};

  for (const tag of ROUTING_TAGS) {
    const candidates = await loadTagSamples(tag, params);
    if (!candidates.length) {
      tagSampleCounts[tag] = 0;
      continue;
    }

    const embeddings = await ensureTweetEmbeddings(candidates);
    const vectors = candidates
      .map((candidate) => embeddings.get(candidate.tweetId))
      .filter((vector): vector is number[] => Array.isArray(vector) && vector.length === dimensions)
      .map((vector) => normalizeVector(vector));

    tagSampleCounts[tag] = vectors.length;
    if (vectors.length < ROUTE_EMBEDDING_MIN_SAMPLE) {
      logger.warn('Routing tag sample insufficient, skip tag', {
        tag,
        count: vectors.length,
        min: ROUTE_EMBEDDING_MIN_SAMPLE
      });
      continue;
    }

    tagSamples[tag] = vectors;
  }

  const negativeCandidates = await loadNegativeSamples(params);
  if (negativeCandidates.length) {
    const embeddings = await ensureTweetEmbeddings(negativeCandidates);
    const vectors = negativeCandidates
      .map((candidate) => embeddings.get(candidate.tweetId))
      .filter((vector): vector is number[] => Array.isArray(vector) && vector.length === dimensions)
      .map((vector) => normalizeVector(vector));
    tagSampleCounts[ROUTING_NEGATIVE_KEY] = vectors.length;
    if (vectors.length >= ROUTE_EMBEDDING_NEG_MIN_SAMPLE) {
      tagSamples[ROUTING_NEGATIVE_KEY] = vectors;
    } else {
      logger.warn('Routing negative sample insufficient, skip negative prototype', {
        count: vectors.length,
        min: ROUTE_EMBEDDING_NEG_MIN_SAMPLE
      });
    }
  } else {
    tagSampleCounts[ROUTING_NEGATIVE_KEY] = 0;
  }

  const availableTags = Object.keys(tagSamples).filter((tag) => tag !== ROUTING_NEGATIVE_KEY);
  if (!availableTags.length) {
    logger.warn('No routing tag samples available');
    return null;
  }

  logger.info('Routing tag samples prepared', {
    tags: availableTags.length,
    negativeSamples: tagSampleCounts[ROUTING_NEGATIVE_KEY] ?? 0,
    windowDays: params.windowDays,
    samplePerTag: params.samplePerTag,
    model,
    dimensions
  });

  return {
    model,
    dimensions,
    tagSamples,
    tagSampleCounts,
    samplePerTag: params.samplePerTag,
    sourceWindowDays: params.windowDays
  };
}

async function persistRoutingTagCache(data: {
  model: string;
  dimensions: number;
  tagSamples: Record<string, number[][]>;
  tagSampleCounts: Record<string, number>;
  samplePerTag: number;
  sourceWindowDays: number;
}) {
  const record = await prisma.routingTagEmbeddingCache.upsert({
    where: { id: ROUTING_TAG_CACHE_ID },
    update: {
      model: data.model,
      dimensions: data.dimensions,
      tagSamples: data.tagSamples,
      tagSampleCounts: data.tagSampleCounts,
      samplePerTag: data.samplePerTag,
      sourceWindowDays: data.sourceWindowDays
    },
    create: {
      id: ROUTING_TAG_CACHE_ID,
      model: data.model,
      dimensions: data.dimensions,
      tagSamples: data.tagSamples,
      tagSampleCounts: data.tagSampleCounts,
      samplePerTag: data.samplePerTag,
      sourceWindowDays: data.sourceWindowDays
    }
  });

  routingTagCache = {
    updatedAtMs: record.updatedAt.getTime(),
    model: record.model,
    dimensions: record.dimensions,
    windowDays: record.sourceWindowDays,
    samplePerTag: record.samplePerTag,
    tagSamples: data.tagSamples,
    tagSampleCounts: data.tagSampleCounts,
    tagCentroids: {},
    tagStats: {},
    tagThresholds: {},
    negativeCentroid: null,
    negativeSampleCount: 0
  };

  const negativeSamples = data.tagSamples[ROUTING_NEGATIVE_KEY] ?? [];
  routingTagCache.negativeSampleCount = negativeSamples.length;
  routingTagCache.negativeCentroid = negativeSamples.length
    ? buildCentroid(negativeSamples, record.dimensions)
    : null;

  Object.entries(data.tagSamples).forEach(([tag, samples]) => {
    if (tag === ROUTING_NEGATIVE_KEY) return;
    if (!samples.length) return;
    const centroid = buildCentroid(samples, record.dimensions);
    const stats = computeTagStats(samples, centroid);
    routingTagCache!.tagCentroids[tag] = centroid;
    routingTagCache!.tagStats[tag] = stats;
    routingTagCache!.tagThresholds[tag] = resolveTagThresholds(tag, stats);
  });

  return routingTagCache;
}

export async function refreshRoutingEmbeddingCache(reason = 'manual', options?: RoutingRefreshOptions) {
  const params = normalizeRoutingRefreshOptions(options);
  if (!embeddingsEnabled()) {
    return { updated: false, reason: 'embeddings-disabled', ...params };
  }
  const data = await buildTagEmbeddingCacheData(params);
  if (!data) {
    return { updated: false, reason: 'insufficient-samples', ...params };
  }
  const cache = await persistRoutingTagCache(data);
  const totalSamples = Object.entries(cache.tagSampleCounts).reduce(
    (acc, [tag, value]) => (tag === ROUTING_NEGATIVE_KEY ? acc : acc + value),
    0
  );
  logger.info('Routing tag cache refreshed', {
    reason,
    tags: Object.keys(cache.tagSamples).length,
    totalSamples,
    model: cache.model,
    dimensions: cache.dimensions,
    windowDays: cache.windowDays,
    samplePerTag: cache.samplePerTag
  });
  return {
    updated: true,
    model: cache.model,
    dimensions: cache.dimensions,
    updatedAt: new Date(cache.updatedAtMs).toISOString(),
    tagSampleCounts: cache.tagSampleCounts,
    totalSamples,
    ...params
  };
}

async function loadRoutingTagCache() {
  if (!embeddingsEnabled()) return null;
  const record = await prisma.routingTagEmbeddingCache.findUnique({ where: { id: ROUTING_TAG_CACHE_ID } });
  if (!record) {
    logger.info('Routing tag cache missing, building');
    const params = normalizeRoutingRefreshOptions();
    const data = await buildTagEmbeddingCacheData(params);
    if (!data) return null;
    return persistRoutingTagCache(data);
  }

  const updatedAtMs = record.updatedAt.getTime();
  if (
    routingTagCache &&
    routingTagCache.updatedAtMs === updatedAtMs &&
    routingTagCache.model === record.model &&
    routingTagCache.dimensions === record.dimensions
  ) {
    return routingTagCache;
  }

  if (record.model !== config.EMBEDDING_MODEL || record.dimensions !== config.EMBEDDING_DIMENSIONS) {
    logger.warn('Routing tag cache model mismatch, rebuilding', {
      storedModel: record.model,
      storedDimensions: record.dimensions,
      currentModel: config.EMBEDDING_MODEL,
      currentDimensions: config.EMBEDDING_DIMENSIONS
    });
    const params = normalizeRoutingRefreshOptions();
    const data = await buildTagEmbeddingCacheData(params);
    if (!data) return null;
    return persistRoutingTagCache(data);
  }

  const params = normalizeRoutingRefreshOptions();
  if (record.sourceWindowDays !== params.windowDays || record.samplePerTag !== params.samplePerTag) {
    logger.info('Routing tag cache params mismatch, rebuilding', {
      storedWindowDays: record.sourceWindowDays,
      storedSamplePerTag: record.samplePerTag,
      currentWindowDays: params.windowDays,
      currentSamplePerTag: params.samplePerTag
    });
    const data = await buildTagEmbeddingCacheData(params);
    if (!data) return null;
    return persistRoutingTagCache(data);
  }

  const tagSamples = parseTagSamples(record.tagSamples, record.dimensions);
  const tagSampleCounts = parseTagSampleCounts(record.tagSampleCounts);
  if (!Object.keys(tagSamples).length) {
    logger.warn('Routing tag cache empty, rebuilding');
    const data = await buildTagEmbeddingCacheData(params);
    if (!data) return null;
    return persistRoutingTagCache(data);
  }

  routingTagCache = {
    updatedAtMs,
    model: record.model,
    dimensions: record.dimensions,
    windowDays: record.sourceWindowDays,
    samplePerTag: record.samplePerTag,
    tagSamples,
    tagSampleCounts,
    tagCentroids: {},
    tagStats: {},
    tagThresholds: {},
    negativeCentroid: null,
    negativeSampleCount: 0
  };

  const negativeSamples = tagSamples[ROUTING_NEGATIVE_KEY] ?? [];
  routingTagCache.negativeSampleCount = negativeSamples.length;
  routingTagCache.negativeCentroid = negativeSamples.length
    ? buildCentroid(negativeSamples, record.dimensions)
    : null;

  Object.entries(tagSamples).forEach(([tag, samples]) => {
    if (tag === ROUTING_NEGATIVE_KEY) return;
    if (!samples.length) return;
    const centroid = buildCentroid(samples, record.dimensions);
    const stats = computeTagStats(samples, centroid);
    routingTagCache.tagCentroids[tag] = centroid;
    routingTagCache.tagStats[tag] = stats;
    routingTagCache.tagThresholds[tag] = resolveTagThresholds(tag, stats);
  });

  return routingTagCache;
}

export async function applyTagRouting(tweets: Tweet[]): Promise<TagRoutingResult> {
  const reasonCounts = new Map<string, number>();
  const decisions = new Map<string, TagRoutingDecision>();
  if (!tweets.length) {
    return { analyzeByTag: new Map(), ignored: [], autoHigh: [], decisions, reasonCounts };
  }
  if (!embeddingsEnabled()) {
    reasonCounts.set('embed-disabled', tweets.length);
    tweets.forEach((tweet) => {
      decisions.set(tweet.id, { status: 'analyze', reason: 'embed-disabled' });
    });
    return { analyzeByTag: new Map([[ROUTING_UNASSIGNED_TAG, tweets]]), ignored: [], autoHigh: [], decisions, reasonCounts };
  }

  const cache = await loadRoutingTagCache();
  if (!cache || !Object.keys(cache.tagSamples).length) {
    reasonCounts.set('embed-no-cache', tweets.length);
    tweets.forEach((tweet) => {
      decisions.set(tweet.id, { status: 'analyze', reason: 'embed-no-cache' });
    });
    return { analyzeByTag: new Map([[ROUTING_UNASSIGNED_TAG, tweets]]), ignored: [], autoHigh: [], decisions, reasonCounts };
  }

  const embeddings = await ensureTweetEmbeddings(tweets.map((tweet) => ({ tweetId: tweet.tweetId, text: tweet.text })));
  const tagList = Object.keys(cache.tagSamples).filter((tag) => tag !== ROUTING_NEGATIVE_KEY);

  const analyzeByTag = new Map<string, Tweet[]>();
  const ignored: Array<{ tweet: Tweet; reason: string }> = [];
  const autoHigh: Array<{ tweet: Tweet; reason: string; tag: string; score: number; importance: number }> = [];

  const bumpReason = (reason: string) => {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  };

  const addAnalyze = (tag: string, tweet: Tweet) => {
    const list = analyzeByTag.get(tag) ?? [];
    list.push(tweet);
    analyzeByTag.set(tag, list);
  };

  tweets.forEach((tweet) => {
    const vector = embeddings.get(tweet.tweetId);
    if (!vector || vector.length !== cache.dimensions) {
      addAnalyze(ROUTING_UNASSIGNED_TAG, tweet);
      bumpReason('embed-missing');
      decisions.set(tweet.id, { status: 'analyze', reason: 'embed-missing' });
      return;
    }
    const normalized = normalizeVector(vector);
    let bestTag = '';
    let bestScore = -1;
    let secondScore = -1;

    for (const tag of tagList) {
      const samples = cache.tagSamples[tag] ?? [];
      if (!samples.length) continue;
      const score = topKMeanScore(normalized, samples, ROUTE_TAG_SCORE_TOP_K);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestTag = tag;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }

    if (!bestTag) {
      addAnalyze(ROUTING_UNASSIGNED_TAG, tweet);
      bumpReason('embed-unrouted');
      decisions.set(tweet.id, { status: 'analyze', reason: 'embed-unrouted' });
      return;
    }

    const thresholds = cache.tagThresholds[bestTag] ?? DEFAULT_TAG_THRESHOLDS;
    const negativeScore = cache.negativeCentroid ? dot(normalized, cache.negativeCentroid) : undefined;
    const negativeGap = negativeScore !== undefined ? bestScore - negativeScore : undefined;

    const isLowScore = bestScore <= thresholds.lowSim;
    const isNegativeLow = negativeGap !== undefined && negativeGap < thresholds.negGapLow;
    if (isLowScore || isNegativeLow) {
      const reason = isLowScore ? 'embed-low' : 'embed-negative';
      ignored.push({ tweet, reason });
      bumpReason(reason);
      const margin = secondScore >= 0 ? bestScore - secondScore : undefined;
      decisions.set(tweet.id, {
        status: 'ignored',
        tag: bestTag,
        score: bestScore,
        margin,
        negativeScore,
        negativeGap,
        reason
      });
      return;
    }

    const hasRunnerUp = secondScore >= 0;
    const margin = hasRunnerUp ? bestScore - secondScore : 0;
    if (
      bestScore >= thresholds.highSim &&
      margin >= thresholds.highMargin &&
      (negativeGap === undefined || negativeGap >= thresholds.negGapHigh)
    ) {
      const importance = bestScore >= thresholds.highStrict ? 5 : 4;
      autoHigh.push({
        tweet,
        reason: 'embed-high',
        tag: bestTag,
        score: bestScore,
        importance
      });
      bumpReason(importance === 5 ? 'embed-high-5' : 'embed-high-4');
      decisions.set(tweet.id, {
        status: 'auto-high',
        tag: bestTag,
        score: bestScore,
        margin,
        negativeScore,
        negativeGap,
        reason: 'embed-high',
        importance
      });
      return;
    }

    addAnalyze(bestTag, tweet);
    bumpReason('embed-analyze');
    decisions.set(tweet.id, {
      status: 'analyze',
      tag: bestTag,
      score: bestScore,
      margin: hasRunnerUp ? margin : undefined,
      negativeScore,
      negativeGap,
      reason: 'embed-analyze'
    });
  });

  return { analyzeByTag, ignored, autoHigh, decisions, reasonCounts };
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
