import { AiRunKind, AiRunStatus, Prisma, Report, ReportProfile, Tweet } from '@prisma/client';
import { prisma } from '../../db';
import { config } from '../../config';
import { logger } from '../../logger';
import { chunk } from '../../utils/chunk';
import { formatDisplayDate, withTz } from '../../utils/time';
import { sendHighScoreMarkdownToTelegram, sendMarkdownToTelegram } from '../notificationService';
import { createEmbeddings, embeddingsEnabled, hashEmbeddingText } from '../embeddingService';
import { clusterByEmbedding } from '../clusterService';
import { runChatCompletion, runStructuredCompletion } from './openaiClient';
import {
  HIGH_PRIORITY_IMPORTANCE,
  TAG_DISPLAY_NAMES,
  TAG_FALLBACK_KEY,
  getErrorMessage,
  isContentRiskMessage,
  isServiceBusyMessage,
  runWithConcurrency,
  truncateText
} from './shared';

const TRIAGE_CHUNK_SIZE = Math.max(1, Math.floor(config.REPORT_MID_TRIAGE_CHUNK_SIZE));
const TRIAGE_MAX_KEEP_PER_CHUNK = Math.max(
  1,
  Math.min(TRIAGE_CHUNK_SIZE, Math.floor(config.REPORT_MID_TRIAGE_MAX_KEEP_PER_CHUNK))
);
const TRIAGE_CONCURRENCY = Math.max(1, Math.floor(config.REPORT_MID_TRIAGE_CONCURRENCY));
const MEDIUM_MIN_IMPORTANCE = 2;
const MEDIUM_MAX_IMPORTANCE = 3;
const REPORT_MIN_IMPORTANCE = Math.max(1, Math.min(5, Math.floor(config.REPORT_MIN_IMPORTANCE ?? MEDIUM_MIN_IMPORTANCE)));
const EMBEDDING_BATCH_SIZE = 10;
const EMBEDDING_TEXT_MAX_LENGTH = 320;
const DEFAULT_REPORT_WINDOW_HOURS = 6;
const SOCIAL_DIGEST_MAX_ITEMS = 60;
const SOCIAL_DIGEST_SUMMARY_MAX_LENGTH = 240;
const SOCIAL_DIGEST_TEXT_MAX_LENGTH = 360;

type InsightWithTweet = Prisma.TweetInsightGetPayload<{ include: { tweet: { include: { subscription: true } } } }>;

interface ReportSectionInsight {
  tweetId: string;
  summary: string;
  importance?: number;
  tags?: string[];
  tweetUrl?: string;
}

interface ReportActionItem {
  description: string;
  tweetId?: string;
}

interface OverflowInsight {
  tweetId: string;
  summary: string;
}

interface ReportPayload {
  headline: string;
  overview: string | string[];
  sections?: Array<{
    title: string;
    insight?: string;
    tweets?: string[];
    items?: ReportSectionInsight[];
  }>;
  actionItems?: ReportActionItem[];
  overflow?: OverflowInsight[];
}

type ReportSection = NonNullable<ReportPayload['sections']>[number];
type ReportWindow = { start: Date; end: Date };
type ReportGroupBy = 'cluster' | 'tag' | 'author';
type SocialDigestItem = {
  summary: string;
  text?: string;
  tags: string[];
  importance?: number | null;
  author?: string;
};

export interface SocialDigestResult {
  content: string;
  usedItems: number;
  totalItems: number;
  periodStart: string;
  periodEnd: string;
}

export interface SocialDigestOptions {
  prompt?: string;
  maxItems?: number;
  includeTweetText?: boolean;
}

interface ClusterReportOutline {
  mode: 'clustered';
  totalInsights: number;
  rawInsights?: number;
  minImportance: number;
  triage?: {
    enabled: boolean;
    highKept: number;
    midCandidates: number;
    midKept: number;
  };
  totalClusters: number;
  shownClusters: number;
  sections: Array<{
    tag: string;
    title: string;
    clusters: Array<{
      id: string;
      size: number;
      peakImportance: number;
      tags: string[];
      representative: {
        tweetId: string;
        tweetUrl: string;
        summary: string;
        importance: number;
        verdict: string;
        suggestions?: string | null;
      };
      memberTweetIds: string[];
    }>;
  }>;
}

async function defaultWindow(): Promise<ReportWindow | null> {
  const now = withTz(new Date(), config.REPORT_TIMEZONE);
  const lastReport = await prisma.report.findFirst({ orderBy: { periodEnd: 'desc' } });
  if (!lastReport) {
    return {
      start: now.subtract(DEFAULT_REPORT_WINDOW_HOURS, 'hour').toDate(),
      end: now.toDate()
    };
  }
  const lastEnd = withTz(lastReport.periodEnd, config.REPORT_TIMEZONE);
  const nextEnd = lastEnd.add(DEFAULT_REPORT_WINDOW_HOURS, 'hour');
  if (now.isBefore(nextEnd)) {
    logger.info('Report generation skipped: previous window still active', {
      lastPeriodEnd: lastReport.periodEnd.toISOString(),
      nextAvailableAt: nextEnd.toDate().toISOString()
    });
    return null;
  }
  return {
    start: lastEnd.toDate(),
    end: nextEnd.toDate()
  };
}

async function selectMidPriorityInsights(
  insights: InsightWithTweet[],
  options?: { prompt?: string | null; maxKeepPerChunk?: number }
) {
  if (!insights.length) {
    return [];
  }
  const maxKeep = Math.max(
    1,
    Math.min(TRIAGE_CHUNK_SIZE, Math.floor(options?.maxKeepPerChunk ?? TRIAGE_MAX_KEEP_PER_CHUNK))
  );
  const batches = chunk(insights, TRIAGE_CHUNK_SIZE);
  const keptIds = new Set<string>();

  await runWithConcurrency(batches, TRIAGE_CONCURRENCY, async (batch, batchIndex) => {
    logger.info('Running mid-priority triage batch', {
      batchIndex: batchIndex + 1,
      batchSize: batch.length
    });
    const prompt = buildTriagePrompt(batch, maxKeep, options?.prompt);
    try {
      const parsed = await runStructuredCompletion<{
        decisions?: Array<{ tweetId: string; include: boolean }>;
      }>(
        {
          model: 'deepseek-chat',
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: '你是资讯编辑，需要快速筛选重要推文，按指引只选择最值得保留的条目。'
            },
            { role: 'user', content: prompt }
          ]
        },
        { stage: 'mid-triage', batchIndex: batchIndex + 1, batchSize: batch.length }
      );
      const includes = (parsed.decisions ?? []).filter((decision) => decision.include);
      includes.slice(0, maxKeep).forEach((decision) => keptIds.add(decision.tweetId));
    } catch (error) {
      const message = getErrorMessage(error);
      const reason = isContentRiskMessage(message) ? 'content-risk' : isServiceBusyMessage(message) ? 'service-busy' : 'failed';
      logger.warn('Mid-priority triage batch skipped; keeping all items in batch', {
        reason,
        batchIndex: batchIndex + 1,
        batchSize: batch.length,
        error: message
      });
      batch.forEach((insight) => keptIds.add(insight.tweetId));
    }
  });

  return insights.filter((insight) => keptIds.has(insight.tweetId));
}

async function triageInsightsForReport(
  insights: InsightWithTweet[],
  options?: { enabled?: boolean; prompt?: string | null; maxKeepPerChunk?: number }
) {
  const high = insights.filter((insight) => (insight.importance ?? 0) >= HIGH_PRIORITY_IMPORTANCE);
  const mid = insights.filter((insight) => {
    const importance = insight.importance ?? 0;
    return importance >= MEDIUM_MIN_IMPORTANCE && importance <= MEDIUM_MAX_IMPORTANCE;
  });
  const triageEnabled = options?.enabled ?? config.REPORT_MID_TRIAGE_ENABLED;

  if (!config.DEEPSEEK_API_KEY || mid.length === 0 || !triageEnabled) {
    return {
      selected: insights,
      stats: {
        enabled: false,
        highKept: high.length,
        midCandidates: mid.length,
        midKept: mid.length
      }
    };
  }

  const orderedMid = [...mid].sort((a, b) => {
    const imp = (b.importance ?? 0) - (a.importance ?? 0);
    if (imp !== 0) return imp;
    return b.tweet.tweetedAt.getTime() - a.tweet.tweetedAt.getTime();
  });

  const triageOptions: { prompt?: string | null; maxKeepPerChunk?: number } = {};
  if (options?.prompt !== undefined) {
    triageOptions.prompt = options.prompt ?? null;
  }
  if (typeof options?.maxKeepPerChunk === 'number') {
    triageOptions.maxKeepPerChunk = options.maxKeepPerChunk;
  }
  const keptMid = await selectMidPriorityInsights(orderedMid, triageOptions);
  if (!keptMid.length && high.length === 0) {
    logger.warn('Mid-priority triage returned empty selection; falling back to original insights', {
      insights: insights.length,
      mid: mid.length
    });
    return {
      selected: insights,
      stats: {
        enabled: true,
        highKept: high.length,
        midCandidates: mid.length,
        midKept: mid.length
      }
    };
  }

  const keptMidIds = new Set(keptMid.map((insight) => insight.tweetId));
  const selected = [...high, ...orderedMid.filter((insight) => keptMidIds.has(insight.tweetId))].sort((a, b) => {
    const imp = (b.importance ?? 0) - (a.importance ?? 0);
    if (imp !== 0) return imp;
    return b.tweet.tweetedAt.getTime() - a.tweet.tweetedAt.getTime();
  });

  return {
    selected,
    stats: {
      enabled: true,
      highKept: high.length,
      midCandidates: mid.length,
      midKept: keptMid.length
    }
  };
}

function buildTriagePrompt(batch: InsightWithTweet[], maxKeep: number, extraPrompt?: string | null) {
  const extra = extraPrompt?.trim();
  const template = {
    goal: '审阅 importance 在 2-3 的推文洞察，只保留最有价值的少量条目，其余标记为 false。',
    rules: [
      `每个 chunk 最多保留 ${maxKeep} 条，优先 actionable、具有明确行动价值或重大信号的内容。`,
      '如果内容重复、缺乏上下文或影响较小，应标记 include=false。',
      extra ? `额外要求：${extra}` : '',
      '只能使用已有的 summary / tags 做判断，不要臆测新信息。',
      '务必以 json 对象输出，禁止添加额外文字说明。'
    ],
    outputSchema: '{"decisions":[{"tweetId":"id","include":true|false}]}',
    candidates: batch.map((insight) => ({
      tweetId: insight.tweetId,
      importance: insight.importance ?? null,
      verdict: insight.verdict,
      summary: insight.summary ?? '',
      tags: insight.tags ?? [],
      suggestions: insight.suggestions ?? undefined
    }))
  };
  template.rules = template.rules.filter((rule) => Boolean(rule?.trim()));
  return JSON.stringify(template);
}

function ensureOverviewList(overview: string | string[] | undefined, totalItems: number) {
  const list = Array.isArray(overview) ? overview.filter(Boolean) : overview ? [overview] : [];
  if (!list.length) {
    list.push('市场依旧多主题并行，需聚焦本日报告列出的重点板块。');
  }
  const totalBullet = `本次共处理 ${totalItems} 条洞察，已全部归入报告结构中。`;
  if (!list.some((entry) => entry.includes(`${totalItems}`))) {
    list.push(totalBullet);
  }
  return list;
}

interface TagBucketItem {
  data: ReportSectionInsight;
  tweetedAt: number;
  importance: number;
}

interface TagBucket {
  key: string;
  title: string;
  items: TagBucketItem[];
}

interface AuthorBucket {
  key: string;
  title: string;
  items: TagBucketItem[];
}

type BucketLike = { items: TagBucketItem[] };

function buildTagReportPayload(
  insights: InsightWithTweet[],
  window: { start: Date; end: Date },
  timezone: string,
  headline?: string,
  preferredTags?: Set<string> | null
): ReportPayload {
  const sections = buildTagSectionsFromInsights(insights, preferredTags);
  const title = headline ?? `${formatDisplayDate(window.end, timezone)} 分类资讯汇总`;
  const overview = ensureOverviewList(buildTagReportOverview(sections, insights.length), insights.length);

  return {
    headline: title,
    overview,
    sections
  };
}

function buildTagSectionsFromInsights(insights: InsightWithTweet[], preferredTags?: Set<string> | null): ReportSection[] {
  const buckets = new Map<string, TagBucket>();

  insights.forEach((insight) => {
    const tagKey = pickPrimaryTag(insight.tags, preferredTags);
    const bucket = ensureBucket(buckets, tagKey);
    const sectionItem: ReportSectionInsight = {
      tweetId: insight.tweetId,
      summary: getInsightSummary(insight),
      tags: insight.tags ?? [],
      tweetUrl: resolveTweetUrl(insight.tweet)
    };
    if (typeof insight.importance === 'number') {
      sectionItem.importance = insight.importance;
    }
    bucket.items.push({
      data: sectionItem,
      tweetedAt: insight.tweet.tweetedAt.getTime(),
      importance: insight.importance ?? 0
    });
  });

  const orderedBuckets = Array.from(buckets.values()).map((bucket) => sortBucketItems(bucket));
  orderedBuckets.sort((a, b) => {
    const diff = bucketPeakImportance(b) - bucketPeakImportance(a);
    if (diff !== 0) {
      return diff;
    }
    if (b.items.length !== a.items.length) {
      return b.items.length - a.items.length;
    }
    return a.title.localeCompare(b.title, 'zh-Hans');
  });

  return orderedBuckets.map((bucket) => ({
    title: bucket.title,
    insight: describeBucket(bucket),
    items: bucket.items.map((entry) => entry.data)
  }));
}

function sortBucketItems<T extends BucketLike>(bucket: T) {
  bucket.items.sort((a, b) => {
    const importanceDelta = (b.importance ?? 0) - (a.importance ?? 0);
    if (importanceDelta !== 0) {
      return importanceDelta;
    }
    return b.tweetedAt - a.tweetedAt;
  });
  return bucket;
}

function bucketPeakImportance(bucket: BucketLike) {
  return bucket.items.reduce((max, entry) => Math.max(max, entry.importance ?? 0), 0);
}

function describeBucket(bucket: BucketLike) {
  const peak = bucketPeakImportance(bucket);
  const rating = peak > 0 ? `${peak}⭐` : '暂无评分';
  return `共 ${bucket.items.length} 条洞察，最高 ${rating}，已按重要度降序排列。`;
}

function pickPrimaryTag(tags?: string[] | null, preferredTags?: Set<string> | null) {
  if (!tags?.length) {
    return TAG_FALLBACK_KEY;
  }
  const normalizedTags = normalizeFilterTags(tags);
  const preferred =
    preferredTags?.size ? normalizedTags.find((tag) => preferredTags.has(tag)) : undefined;
  const fallback = preferred ?? normalizedTags[0] ?? TAG_FALLBACK_KEY;
  return TAG_DISPLAY_NAMES[fallback] ? fallback : TAG_FALLBACK_KEY;
}

function ensureBucket(store: Map<string, TagBucket>, key: string) {
  const normalized = key ? key.toLowerCase() : TAG_FALLBACK_KEY;
  const existing = store.get(normalized);
  if (existing) {
    return existing;
  }
  const bucket: TagBucket = {
    key: normalized,
    title: TAG_DISPLAY_NAMES[normalized] ?? normalized,
    items: []
  };
  store.set(normalized, bucket);
  return bucket;
}

function buildTagReportOverview(sections: ReportSection[], totalItems: number) {
  const overview: string[] = [];
  if (sections.length) {
    const highlights = sections
      .slice(0, 3)
      .map((section) => `${section.title}（${section.items?.length ?? 0}）`)
      .join('、');
    if (highlights) {
      overview.push(`重点分类：${highlights}`);
    }
  }
  overview.push(`本次共保留 ${totalItems} 条洞察，均按标签与重要度排序，便于直接引用。`);
  return overview;
}

function buildAuthorReportPayload(
  insights: InsightWithTweet[],
  window: { start: Date; end: Date },
  timezone: string,
  headline?: string
): ReportPayload {
  const sections = buildAuthorSectionsFromInsights(insights);
  const title = headline ?? `${formatDisplayDate(window.end, timezone)} 作者热度汇总`;
  const overview = ensureOverviewList(buildAuthorReportOverview(sections, insights.length), insights.length);
  return {
    headline: title,
    overview,
    sections
  };
}

function buildAuthorSectionsFromInsights(insights: InsightWithTweet[]): ReportSection[] {
  const buckets = new Map<string, AuthorBucket>();

  insights.forEach((insight) => {
    const title = formatAuthorTitle(insight.tweet);
    const handle = insight.tweet.authorScreen?.replace(/^@/, '').trim().toLowerCase();
    const name = insight.tweet.authorName?.trim().toLowerCase();
    const key = handle || name || insight.tweet.tweetId;
    const bucket = buckets.get(key) ?? { key, title, items: [] };
    const sectionItem: ReportSectionInsight = {
      tweetId: insight.tweetId,
      summary: getInsightSummary(insight),
      tags: insight.tags ?? [],
      tweetUrl: resolveTweetUrl(insight.tweet)
    };
    if (typeof insight.importance === 'number') {
      sectionItem.importance = insight.importance;
    }
    bucket.items.push({
      data: sectionItem,
      tweetedAt: insight.tweet.tweetedAt.getTime(),
      importance: insight.importance ?? 0
    });
    buckets.set(key, bucket);
  });

  const orderedBuckets = Array.from(buckets.values()).map((bucket) => sortBucketItems(bucket));
  orderedBuckets.sort((a, b) => {
    const diff = bucketPeakImportance(b) - bucketPeakImportance(a);
    if (diff !== 0) {
      return diff;
    }
    if (b.items.length !== a.items.length) {
      return b.items.length - a.items.length;
    }
    return a.title.localeCompare(b.title, 'zh-Hans');
  });

  return orderedBuckets.map((bucket) => ({
    title: bucket.title,
    insight: describeBucket(bucket),
    items: bucket.items.map((entry) => entry.data)
  }));
}

function buildAuthorReportOverview(sections: ReportSection[], totalItems: number) {
  const overview: string[] = [];
  if (sections.length) {
    const highlights = sections
      .slice(0, 3)
      .map((section) => `${section.title}（${section.items?.length ?? 0}）`)
      .join('、');
    if (highlights) {
      overview.push(`热点作者：${highlights}`);
    }
  }
  overview.push(`本次共保留 ${totalItems} 条洞察，按作者与重要度排序。`);
  return overview;
}

function formatAuthorTitle(tweet: Tweet) {
  const handle = tweet.authorScreen?.replace(/^@/, '').trim();
  const name = tweet.authorName?.trim();
  if (handle && name) {
    if (name.toLowerCase().includes(handle.toLowerCase())) {
      return name;
    }
    return `${name} (@${handle})`;
  }
  if (handle) {
    return `@${handle}`;
  }
  return name || 'Unknown';
}

function resolveTweetUrl(tweet: Tweet) {
  if (tweet.tweetUrl?.startsWith('http')) {
    return tweet.tweetUrl;
  }
  const handle = tweet.authorScreen?.replace(/^@/, '') ?? 'i/web';
  return `https://twitter.com/${handle}/status/${tweet.tweetId}`;
}

function getInsightSummary(insight: InsightWithTweet) {
  if (insight.summary?.trim()) {
    return insight.summary.trim();
  }
  return truncateText(insight.tweet.text);
}

function buildEmbeddingText(insight: InsightWithTweet) {
  const base = getInsightSummary(insight);
  const cleaned = base.replace(/\s+/g, ' ').trim();
  return truncateText(cleaned, EMBEDDING_TEXT_MAX_LENGTH);
}

async function ensureEmbeddingsForInsights(insights: InsightWithTweet[]) {
  if (!insights.length) {
    return { eligible: 0, embedded: 0, updated: 0 };
  }
  if (!embeddingsEnabled()) {
    logger.warn('Embeddings disabled, missing DASHSCOPE_API_KEY');
    return { eligible: insights.length, embedded: 0, updated: 0 };
  }

  const model = config.EMBEDDING_MODEL;
  const dimensions = config.EMBEDDING_DIMENSIONS;
  const now = new Date();
  const work = insights
    .map((insight) => {
      const text = buildEmbeddingText(insight);
      const textHash = hashEmbeddingText(text);
      const hasVector = Array.isArray(insight.embedding) && insight.embedding.length === dimensions;
      const fresh =
        hasVector &&
        insight.embeddingModel === model &&
        insight.embeddingDimensions === dimensions &&
        insight.embeddingTextHash === textHash;
      return fresh
        ? null
        : {
            tweetId: insight.tweetId,
            text,
            textHash
          };
    })
    .filter((value): value is { tweetId: string; text: string; textHash: string } => Boolean(value));

  if (!work.length) {
    const embedded = insights.filter((insight) => Array.isArray(insight.embedding) && insight.embedding.length === dimensions)
      .length;
    return { eligible: insights.length, embedded, updated: 0 };
  }

  logger.info('Preparing embeddings for report insights', {
    eligible: insights.length,
    missingOrStale: work.length,
    model,
    dimensions
  });

  let updated = 0;
  const batches = chunk(work, EMBEDDING_BATCH_SIZE);
  for (const [batchIndex, batch] of batches.entries()) {
    const vectors = await createEmbeddings(batch.map((item) => item.text));
    if (vectors.length !== batch.length) {
      throw new Error(`Embedding batch size mismatch: expected ${batch.length}, got ${vectors.length}`);
    }
    await prisma.$transaction(
      batch.map((item, index) =>
        prisma.tweetInsight.update({
          where: { tweetId: item.tweetId },
          data: {
            embedding: vectors[index] ?? [],
            embeddingModel: model,
            embeddingDimensions: dimensions,
            embeddingTextHash: item.textHash,
            embeddedAt: now
          }
        })
      )
    );
    updated += batch.length;
    if ((batchIndex + 1) % 10 === 0 || batchIndex === batches.length - 1) {
      logger.info('Embeddings batch stored', { batchIndex: batchIndex + 1, batches: batches.length, updated });
    }
  }

  const embedded = insights.filter((insight) => Array.isArray(insight.embedding) && insight.embedding.length === dimensions)
    .length;
  return { eligible: insights.length, embedded, updated };
}

function normalizeFilterTags(tags?: string[] | null) {
  if (!Array.isArray(tags)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  tags
    .map((tag) => tag.trim().toLowerCase())
    .map((tag) => (tag === 'others' ? TAG_FALLBACK_KEY : tag))
    .filter((tag) => Boolean(tag))
    .forEach((tag) => {
      if (seen.has(tag)) return;
      seen.add(tag);
      normalized.push(tag);
    });
  return normalized;
}

function buildPreferredTagSet(tags?: string[] | null) {
  const normalized = normalizeFilterTags(tags);
  return normalized.length ? new Set(normalized) : null;
}

function hasOverlap(values: string[], filter: Set<string>) {
  return values.some((value) => filter.has(value));
}

function normalizeGroupBy(value?: string | null): ReportGroupBy {
  if (value === 'tag' || value === 'author' || value === 'cluster') {
    return value;
  }
  return 'cluster';
}

function resolveProfileWindow(profile: ReportProfile, end?: Date): ReportWindow {
  const timezone = profile.timezone?.trim() || config.REPORT_TIMEZONE;
  const endTime = withTz(end ?? new Date(), timezone).second(0).millisecond(0);
  const startTime = endTime.subtract(profile.windowHours, 'hour');
  return { start: startTime.toDate(), end: endTime.toDate() };
}

function buildProfileHeadline(profile: ReportProfile, window: ReportWindow) {
  const timezone = profile.timezone?.trim() || config.REPORT_TIMEZONE;
  return `${formatDisplayDate(window.end, timezone)} ${profile.name}`;
}

function applyProfileFilters(insights: InsightWithTweet[], profile: ReportProfile) {
  const minImportance = Math.max(1, Math.min(5, Math.floor(profile.minImportance ?? REPORT_MIN_IMPORTANCE)));
  const includeTweetTags = new Set(normalizeFilterTags(profile.includeTweetTags));
  const excludeTweetTags = new Set(normalizeFilterTags(profile.excludeTweetTags));
  const includeAuthorTags = new Set(normalizeFilterTags(profile.includeAuthorTags));
  const excludeAuthorTags = new Set(normalizeFilterTags(profile.excludeAuthorTags));
  const verdicts = normalizeFilterTags(profile.verdicts);
  const allowedVerdicts = verdicts.length ? new Set(verdicts) : null;

  const filtered = insights.filter((insight) => {
    if ((insight.importance ?? 0) < minImportance) {
      return false;
    }
    const verdict = insight.verdict?.toLowerCase();
    if (allowedVerdicts && (!verdict || !allowedVerdicts.has(verdict))) {
      return false;
    }
    const tweetTags = normalizeFilterTags(insight.tags ?? []);
    if (includeTweetTags.size && !hasOverlap(tweetTags, includeTweetTags)) {
      return false;
    }
    if (excludeTweetTags.size && hasOverlap(tweetTags, excludeTweetTags)) {
      return false;
    }
    const authorTags = normalizeFilterTags(insight.tweet.subscription?.tags ?? []);
    if (includeAuthorTags.size && !hasOverlap(authorTags, includeAuthorTags)) {
      return false;
    }
    if (excludeAuthorTags.size && hasOverlap(authorTags, excludeAuthorTags)) {
      return false;
    }
    return true;
  });

  return { filtered, minImportance };
}

function renderClusterReportMarkdown(
  outline: ClusterReportOutline,
  window: { start: Date; end: Date },
  timezone: string,
  headline: string
) {
  const triage = outline.triage;
  const hasTriage = Boolean(
    triage?.enabled &&
      typeof outline.rawInsights === 'number' &&
      outline.rawInsights > 0 &&
      outline.rawInsights !== outline.totalInsights
  );
  const overviewLine = hasTriage
    ? `- 本次共 ${outline.rawInsights} 条洞察（importance≥${outline.minImportance}），其中 ${
        triage?.highKept ?? 0
      } 条（4-5⭐）全保留；${
        triage?.midCandidates ?? 0
      } 条（2-3⭐）二次筛选后保留 ${triage?.midKept ?? 0} 条；用于聚类 ${outline.totalInsights} 条，聚合为 ${
        outline.totalClusters
      } 个主题簇，展示 ${outline.shownClusters} 个。`
    : `- 本次共 ${outline.totalInsights} 条洞察（importance≥${outline.minImportance}），聚合为 ${outline.totalClusters} 个主题簇，展示 ${outline.shownClusters} 个。`;
  const lines = [
    `# ${headline}`,
    `> 时间范围：${formatDisplayDate(window.start, timezone)} - ${formatDisplayDate(
      window.end,
      timezone
    )}`,
    '',
    '## 概览',
    overviewLine,
    '',
    '## 分类'
  ];

  outline.sections.forEach((section) => {
    lines.push(`\n### ${section.title}\n`);
    section.clusters.forEach((cluster) => {
      const tags = cluster.tags.length ? ` [${cluster.tags.slice(0, 5).join(', ')}]` : '';
      const brief = cluster.representative.summary;
      const link = `[推文](${cluster.representative.tweetUrl})`;
      lines.push(
        `- ${brief}（${cluster.size}条 / 最高${cluster.peakImportance}⭐）${link ? ` ${link}` : ''}${tags}`
      );
    });
  });

  return lines.join('\n');
}

function extractTweetIdsFromOutline(outline: unknown): string[] {
  if (!outline || typeof outline !== 'object') {
    return [];
  }
  const outlineRecord = outline as Record<string, unknown>;
  if (outlineRecord.mode === 'clustered') {
    const sections = Array.isArray(outlineRecord.sections) ? outlineRecord.sections : [];
    const ids: string[] = [];
    sections.forEach((section) => {
      if (!section || typeof section !== 'object') return;
      const clusters = Array.isArray((section as Record<string, unknown>).clusters)
        ? ((section as Record<string, unknown>).clusters as unknown[])
        : [];
      clusters.forEach((cluster) => {
        if (!cluster || typeof cluster !== 'object') return;
        const representative = (cluster as Record<string, unknown>).representative as Record<string, unknown> | undefined;
        const tweetId = representative?.tweetId;
        if (typeof tweetId === 'string' && tweetId.trim()) {
          ids.push(tweetId.trim());
        }
      });
    });
    return uniqueTweetIds(ids);
  }

  const sections = Array.isArray(outlineRecord.sections) ? outlineRecord.sections : [];
  const ids: string[] = [];
  sections.forEach((section) => {
    if (!section || typeof section !== 'object') return;
    const record = section as Record<string, unknown>;
    const items = Array.isArray(record.items) ? (record.items as unknown[]) : [];
    items.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const tweetId = (item as Record<string, unknown>).tweetId;
      if (typeof tweetId === 'string' && tweetId.trim()) {
        ids.push(tweetId.trim());
      }
    });
    const tweets = Array.isArray(record.tweets) ? (record.tweets as unknown[]) : [];
    tweets.forEach((entry) => {
      if (typeof entry !== 'string') return;
      const match = entry.match(/\d{10,}/g);
      if (!match) return;
      match.forEach((value) => ids.push(value));
    });
  });

  return uniqueTweetIds(ids);
}

function uniqueTweetIds(ids: string[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  ids.forEach((id) => {
    if (!id) return;
    if (seen.has(id)) return;
    seen.add(id);
    output.push(id);
  });
  return output;
}

function buildSocialDigestPrompt(options: {
  start: string;
  end: string;
  timezone: string;
  items: SocialDigestItem[];
  extraPrompt?: string;
}) {
  const extra = options.extraPrompt?.trim();
  const hasText = options.items.some((item) => Boolean(item.text));
  const rules = [
    '中文输出，口语化、精炼、总结型，可长文。',
    '不使用营销式话术，不夸大，不编造未提供的信息。',
    '不要输出链接、tweetId 或来源标注；不加 hashtags。',
    '句子短，主体可用短段落或短清单（最多 7 条）。',
    `开头必须明确时间范围：${options.start} - ${options.end}（${options.timezone}）。`,
    '如果素材不足，用“目前只看到…”说明，不要猜测。'
  ];
  if (hasText) {
    rules.push('text 字段是原文片段，必要时参考，但仍以 summary 为主。');
  }
  if (extra) {
    rules.push(`额外要求：${extra}`);
  }
  return [
    `请根据以下素材撰写一篇社媒日报。`,
    `时间范围：${options.start} - ${options.end}（${options.timezone}）。`,
    '要求：',
    ...rules.map((rule) => `- ${rule}`),
    '',
    '素材（仅可基于以下内容）：',
    JSON.stringify(options.items, null, 2)
  ].join('\n');
}

export async function generateSocialDigestFromReport(
  report: Report,
  options: SocialDigestOptions = {}
): Promise<SocialDigestResult> {
  const tweetIds = extractTweetIdsFromOutline(report.outline as unknown);
  if (!tweetIds.length) {
    throw new Error('Report outline missing tweet references');
  }
  const maxItems = Math.max(5, Math.min(options.maxItems ?? SOCIAL_DIGEST_MAX_ITEMS, 200));
  const selectedIds = tweetIds.slice(0, maxItems);
  const orderMap = new Map(selectedIds.map((id, index) => [id, index]));

  const insights = await prisma.tweetInsight.findMany({
    where: { tweetId: { in: selectedIds } },
    include: { tweet: { include: { subscription: true } } }
  });

  insights.sort((a, b) => (orderMap.get(a.tweetId) ?? 0) - (orderMap.get(b.tweetId) ?? 0));

  const items = insights.map((insight) => {
    const summary = truncateText(getInsightSummary(insight), SOCIAL_DIGEST_SUMMARY_MAX_LENGTH);
    const text =
      options.includeTweetText && insight.tweet.text
        ? truncateText(insight.tweet.text, SOCIAL_DIGEST_TEXT_MAX_LENGTH)
        : undefined;
    return {
      summary,
      ...(text ? { text } : {}),
      tags: insight.tags ?? [],
      importance: insight.importance ?? null,
      author: formatAuthorTitle(insight.tweet)
    };
  });

  if (!items.length) {
    throw new Error('No insights available for social digest');
  }

  const profile = report.profileId
    ? await prisma.reportProfile.findUnique({
        where: { id: report.profileId },
        select: { timezone: true }
      })
    : null;
  const timezone = profile?.timezone?.trim() || config.REPORT_TIMEZONE;
  const start = formatDisplayDate(report.periodStart, timezone);
  const end = formatDisplayDate(report.periodEnd, timezone);
  const promptPayload: {
    start: string;
    end: string;
    timezone: string;
    items: SocialDigestItem[];
    extraPrompt?: string;
  } = { start, end, timezone, items };
  if (options.prompt !== undefined) {
    promptPayload.extraPrompt = options.prompt;
  }
  const prompt = buildSocialDigestPrompt(promptPayload);

  const content = await runChatCompletion(
    {
      model: 'deepseek-chat',
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: '你是资深内容编辑，擅长将资讯列表写成中文社媒日报。'
        },
        { role: 'user', content: prompt }
      ]
    },
    { stage: 'social-digest', reportId: report.id, items: items.length }
  );

  return {
    content,
    usedItems: items.length,
    totalItems: tweetIds.length,
    periodStart: report.periodStart.toISOString(),
    periodEnd: report.periodEnd.toISOString()
  };
}

export async function generateReportForProfile(profile: ReportProfile, windowEnd?: Date) {
  const reportWindow = resolveProfileWindow(profile, windowEnd);
  const timezone = profile.timezone?.trim() || config.REPORT_TIMEZONE;
  const windowMeta = {
    start: reportWindow.start.toISOString(),
    end: reportWindow.end.toISOString(),
    profileId: profile.id
  };
  logger.info('Report profile generation requested', {
    ...windowMeta,
    profileName: profile.name,
    groupBy: profile.groupBy
  });

  const existing = await prisma.report.findFirst({
    where: { profileId: profile.id, periodEnd: reportWindow.end }
  });
  if (existing) {
    logger.info('Report profile window already generated, skipping', windowMeta);
    return null;
  }

  const insights = await prisma.tweetInsight.findMany({
    where: {
      tweet: {
        tweetedAt: { gte: reportWindow.start, lte: reportWindow.end }
      },
      verdict: { not: 'ignore' }
    },
    include: { tweet: { include: { subscription: true } } },
    orderBy: { createdAt: 'asc' }
  });

  if (!insights.length) {
    logger.info('No insights available for report profile', windowMeta);
    return null;
  }

  const { filtered: eligible, minImportance } = applyProfileFilters(insights, profile);
  const preferredTagSet = buildPreferredTagSet(profile.includeTweetTags);
  if (!eligible.length) {
    logger.info('No insights left after profile filters', { ...windowMeta, total: insights.length });
    return null;
  }

  const aiRun = await prisma.aiRun.create({
    data: { kind: AiRunKind.REPORT_SUMMARY, status: AiRunStatus.RUNNING }
  });

  try {
    const completeAiRun = async () => {
      await prisma.aiRun.update({
        where: { id: aiRun.id },
        data: { status: AiRunStatus.COMPLETED, completedAt: new Date() }
      });
    };

    const triageOptions: { enabled?: boolean; prompt?: string | null; maxKeepPerChunk?: number } = {};
    if (typeof profile.aiFilterEnabled === 'boolean') {
      triageOptions.enabled = profile.aiFilterEnabled;
    }
    if (profile.aiFilterPrompt !== undefined) {
      triageOptions.prompt = profile.aiFilterPrompt ?? null;
    }
    if (typeof profile.aiFilterMaxKeepPerChunk === 'number') {
      triageOptions.maxKeepPerChunk = profile.aiFilterMaxKeepPerChunk;
    }
    const { selected: reportInsights, stats: triageStats } = await triageInsightsForReport(eligible, triageOptions);

    if (!reportInsights.length) {
      logger.info('No insights kept after profile triage', windowMeta);
      await completeAiRun();
      return null;
    }

    if (triageStats.enabled && reportInsights.length !== eligible.length) {
      logger.info('Profile triage completed', {
        ...windowMeta,
        eligible: eligible.length,
        selected: reportInsights.length,
        highKept: triageStats.highKept,
        midCandidates: triageStats.midCandidates,
        midKept: triageStats.midKept
      });
    }

    const groupBy = normalizeGroupBy(profile.groupBy);
    const headline = buildProfileHeadline(profile, reportWindow);

    if (groupBy === 'tag') {
      const blueprint = buildTagReportPayload(reportInsights, reportWindow, timezone, headline, preferredTagSet);
      if (!blueprint.sections?.length) {
        logger.info('Profile tag report builder produced no sections', windowMeta);
        await completeAiRun();
        return null;
      }
      const markdown = renderReportMarkdown(blueprint, reportWindow, timezone);
      const report = await prisma.report.create({
        data: {
          periodStart: reportWindow.start,
          periodEnd: reportWindow.end,
          headline: blueprint.headline,
          content: markdown,
          outline: blueprint as unknown as Prisma.JsonObject,
          aiRunId: aiRun.id,
          profileId: profile.id
        }
      });
      await prisma.aiRun.update({
        where: { id: aiRun.id },
        data: { status: AiRunStatus.COMPLETED, completedAt: new Date() }
      });
      return report;
    }

    if (groupBy === 'author') {
      const blueprint = buildAuthorReportPayload(reportInsights, reportWindow, timezone, headline);
      if (!blueprint.sections?.length) {
        logger.info('Profile author report builder produced no sections', windowMeta);
        await completeAiRun();
        return null;
      }
      const markdown = renderReportMarkdown(blueprint, reportWindow, timezone);
      const report = await prisma.report.create({
        data: {
          periodStart: reportWindow.start,
          periodEnd: reportWindow.end,
          headline: blueprint.headline,
          content: markdown,
          outline: blueprint as unknown as Prisma.JsonObject,
          aiRunId: aiRun.id,
          profileId: profile.id
        }
      });
      await prisma.aiRun.update({
        where: { id: aiRun.id },
        data: { status: AiRunStatus.COMPLETED, completedAt: new Date() }
      });
      return report;
    }

    const embeddingStats = await ensureEmbeddingsForInsights(reportInsights);
    logger.info('Profile embedding preparation completed', { ...windowMeta, ...embeddingStats });

    const dimensions = config.EMBEDDING_DIMENSIONS;
    const eligibleWithEmbeddings =
      embeddingStats.updated > 0
        ? await prisma.tweetInsight.findMany({
            where: { tweetId: { in: reportInsights.map((insight) => insight.tweetId) } },
            include: { tweet: { include: { subscription: true } } },
            orderBy: { createdAt: 'asc' }
          })
        : reportInsights;

    const candidates = eligibleWithEmbeddings
      .filter((insight) => Array.isArray(insight.embedding) && insight.embedding.length === dimensions)
      .map((insight) => {
        const tweetUrl = resolveTweetUrl(insight.tweet);
        const summary = getInsightSummary(insight);
        return {
          tweetId: insight.tweetId,
          summary,
          importance: insight.importance ?? 0,
          verdict: insight.verdict,
          tags: insight.tags ?? [],
          tweetedAt: insight.tweet.tweetedAt.getTime(),
          tweetUrl,
          suggestions: insight.suggestions ?? null,
          vector: insight.embedding ?? []
        };
      });

    if (!candidates.length) {
      logger.warn('No embeddings available for profile insights, falling back to tag report', windowMeta);
      const blueprint = buildTagReportPayload(reportInsights, reportWindow, timezone, headline, preferredTagSet);
      if (!blueprint.sections?.length) {
        logger.info('Profile fallback tag report builder produced no sections', windowMeta);
        await completeAiRun();
        return null;
      }
      const markdown = renderReportMarkdown(blueprint, reportWindow, timezone);
      const report = await prisma.report.create({
        data: {
          periodStart: reportWindow.start,
          periodEnd: reportWindow.end,
          headline: blueprint.headline,
          content: markdown,
          outline: blueprint as unknown as Prisma.JsonObject,
          aiRunId: aiRun.id,
          profileId: profile.id
        }
      });
      await prisma.aiRun.update({
        where: { id: aiRun.id },
        data: { status: AiRunStatus.COMPLETED, completedAt: new Date() }
      });
      return report;
    }

    const clusters = clusterByEmbedding(candidates, {
      threshold: config.REPORT_CLUSTER_THRESHOLD
    });
    const maxClusters = config.REPORT_CLUSTER_MAX;
    const shown = maxClusters > 0 ? Math.min(maxClusters, clusters.length) : clusters.length;
    const displayClusters = clusters.slice(0, shown);

    const buckets = new Map<string, ClusterReportOutline['sections'][number]>();
    displayClusters.forEach((cluster) => {
      const primary = pickPrimaryTag(cluster.representative.tags, preferredTagSet);
      const bucket = buckets.get(primary) ?? {
        tag: primary,
        title: TAG_DISPLAY_NAMES[primary] ?? primary,
        clusters: []
      };
      bucket.clusters.push({
        id: cluster.id,
        size: cluster.size,
        peakImportance: cluster.peakImportance,
        tags: cluster.tags,
        representative: {
          tweetId: cluster.representative.tweetId,
          tweetUrl: cluster.representative.tweetUrl,
          summary: truncateText(cluster.representative.summary, 160),
          importance: cluster.representative.importance,
          verdict: cluster.representative.verdict,
          suggestions: cluster.representative.suggestions ?? null
        },
        memberTweetIds: cluster.memberTweetIds
      });
      buckets.set(primary, bucket);
    });

    const sections = Array.from(buckets.values()).map((section) => {
      section.clusters.sort((a, b) => {
        const imp = b.peakImportance - a.peakImportance;
        if (imp !== 0) return imp;
        if (b.size !== a.size) return b.size - a.size;
        return a.id.localeCompare(b.id);
      });
      return section;
    });
    sections.sort((a, b) => {
      const peakA = a.clusters.reduce((max, cluster) => Math.max(max, cluster.peakImportance), 0);
      const peakB = b.clusters.reduce((max, cluster) => Math.max(max, cluster.peakImportance), 0);
      const imp = peakB - peakA;
      if (imp !== 0) return imp;
      if (b.clusters.length !== a.clusters.length) return b.clusters.length - a.clusters.length;
      return a.title.localeCompare(b.title, 'zh-Hans');
    });

    const outline: ClusterReportOutline = {
      mode: 'clustered',
      totalInsights: reportInsights.length,
      rawInsights: eligible.length,
      minImportance,
      triage: {
        enabled: triageStats.enabled,
        highKept: triageStats.highKept,
        midCandidates: triageStats.midCandidates,
        midKept: triageStats.midKept
      },
      totalClusters: clusters.length,
      shownClusters: shown,
      sections
    };

    const markdown = renderClusterReportMarkdown(outline, reportWindow, timezone, headline);

    const report = await prisma.report.create({
      data: {
        periodStart: reportWindow.start,
        periodEnd: reportWindow.end,
        headline,
        content: markdown,
        outline: outline as unknown as Prisma.JsonObject,
        aiRunId: aiRun.id,
        profileId: profile.id
      }
    });

    await prisma.aiRun.update({
      where: { id: aiRun.id },
      data: { status: AiRunStatus.COMPLETED, completedAt: new Date() }
    });

    logger.info('Report profile generation completed', {
      ...windowMeta,
      reportId: report.id,
      insights: insights.length,
      eligible: eligible.length,
      clusterCandidates: outline.totalInsights,
      triageEnabled: triageStats.enabled,
      triageHighKept: triageStats.highKept,
      triageMidCandidates: triageStats.midCandidates,
      triageMidKept: triageStats.midKept,
      clusters: outline.totalClusters,
      shownClusters: outline.shownClusters
    });

    return report;
  } catch (error) {
    await prisma.aiRun.update({
      where: { id: aiRun.id },
      data: {
        status: AiRunStatus.FAILED,
        error: error instanceof Error ? error.message : 'unknown error',
        completedAt: new Date()
      }
    });
    logger.error('Report profile generation failed', error);
    throw error;
  }
}

export async function generateReport(window?: ReportWindow | null) {
  const resolvedWindow = window ?? (await defaultWindow());
  if (!resolvedWindow) {
    return null;
  }
  const reportWindow = resolvedWindow;
  const windowMeta = { start: reportWindow.start.toISOString(), end: reportWindow.end.toISOString() };
  logger.info('Report generation requested', windowMeta);
  const insights = await prisma.tweetInsight.findMany({
    where: {
      tweet: {
        tweetedAt: { gte: reportWindow.start, lte: reportWindow.end }
      },
      verdict: { not: 'ignore' }
    },
    include: { tweet: { include: { subscription: true } } },
    orderBy: { createdAt: 'asc' }
  });

  if (!insights.length) {
    logger.info('No insights available for report generation', windowMeta);
    return null;
  }

  const aiRun = await prisma.aiRun.create({
    data: { kind: AiRunKind.REPORT_SUMMARY, status: AiRunStatus.RUNNING }
  });

  try {
    const eligible = insights.filter((insight) => (insight.importance ?? 0) >= REPORT_MIN_IMPORTANCE);
    if (!eligible.length) {
      logger.info('No insights above importance threshold for report', windowMeta);
      return null;
    }

    const { selected: reportInsights, stats: triageStats } = await triageInsightsForReport(eligible);
    if (triageStats.enabled && reportInsights.length !== eligible.length) {
      logger.info('Mid-priority triage completed for report', {
        ...windowMeta,
        eligible: eligible.length,
        selected: reportInsights.length,
        highKept: triageStats.highKept,
        midCandidates: triageStats.midCandidates,
        midKept: triageStats.midKept
      });
    }

    const embeddingStats = await ensureEmbeddingsForInsights(reportInsights);
    logger.info('Embedding preparation completed', { ...windowMeta, ...embeddingStats });

    const dimensions = config.EMBEDDING_DIMENSIONS;
    const eligibleWithEmbeddings =
      embeddingStats.updated > 0
        ? await prisma.tweetInsight.findMany({
            where: { tweetId: { in: reportInsights.map((insight) => insight.tweetId) } },
            include: { tweet: { include: { subscription: true } } },
            orderBy: { createdAt: 'asc' }
          })
        : reportInsights;

    const candidates = eligibleWithEmbeddings
      .filter((insight) => Array.isArray(insight.embedding) && insight.embedding.length === dimensions)
      .map((insight) => {
        const tweetUrl = resolveTweetUrl(insight.tweet);
        const summary = getInsightSummary(insight);
        return {
          tweetId: insight.tweetId,
          summary,
          importance: insight.importance ?? 0,
          verdict: insight.verdict,
          tags: insight.tags ?? [],
          tweetedAt: insight.tweet.tweetedAt.getTime(),
          tweetUrl,
          suggestions: insight.suggestions ?? null,
          vector: insight.embedding ?? []
        };
      });

    if (!candidates.length) {
      logger.warn('No embeddings available for eligible insights, falling back to tag report', {
        ...windowMeta,
        eligible: reportInsights.length
      });
      const blueprint = buildTagReportPayload(reportInsights, reportWindow, config.REPORT_TIMEZONE);
      if (!blueprint.sections?.length) {
        logger.info('Tag-based report builder produced no sections', windowMeta);
        return null;
      }
      const markdown = renderReportMarkdown(blueprint, reportWindow, config.REPORT_TIMEZONE);
      const report = await prisma.report.create({
        data: {
          periodStart: reportWindow.start,
          periodEnd: reportWindow.end,
          headline: blueprint.headline,
          content: markdown,
          outline: blueprint as unknown as Prisma.JsonObject,
          aiRunId: aiRun.id
        }
      });
      await prisma.aiRun.update({
        where: { id: aiRun.id },
        data: { status: AiRunStatus.COMPLETED, completedAt: new Date() }
      });
      return report;
    }

    const clusters = clusterByEmbedding(candidates, {
      threshold: config.REPORT_CLUSTER_THRESHOLD
    });
    const maxClusters = config.REPORT_CLUSTER_MAX;
    const shown = maxClusters > 0 ? Math.min(maxClusters, clusters.length) : clusters.length;
    const displayClusters = clusters.slice(0, shown);

    const buckets = new Map<string, ClusterReportOutline['sections'][number]>();
    displayClusters.forEach((cluster) => {
      const primary = pickPrimaryTag(cluster.representative.tags);
      const bucket = buckets.get(primary) ?? {
        tag: primary,
        title: TAG_DISPLAY_NAMES[primary] ?? primary,
        clusters: []
      };
      bucket.clusters.push({
        id: cluster.id,
        size: cluster.size,
        peakImportance: cluster.peakImportance,
        tags: cluster.tags,
        representative: {
          tweetId: cluster.representative.tweetId,
          tweetUrl: cluster.representative.tweetUrl,
          summary: truncateText(cluster.representative.summary, 160),
          importance: cluster.representative.importance,
          verdict: cluster.representative.verdict,
          suggestions: cluster.representative.suggestions ?? null
        },
        memberTweetIds: cluster.memberTweetIds
      });
      buckets.set(primary, bucket);
    });

    const sections = Array.from(buckets.values()).map((section) => {
      section.clusters.sort((a, b) => {
        const imp = b.peakImportance - a.peakImportance;
        if (imp !== 0) return imp;
        if (b.size !== a.size) return b.size - a.size;
        return a.id.localeCompare(b.id);
      });
      return section;
    });
    sections.sort((a, b) => {
      const peakA = a.clusters.reduce((max, cluster) => Math.max(max, cluster.peakImportance), 0);
      const peakB = b.clusters.reduce((max, cluster) => Math.max(max, cluster.peakImportance), 0);
      const imp = peakB - peakA;
      if (imp !== 0) return imp;
      if (b.clusters.length !== a.clusters.length) return b.clusters.length - a.clusters.length;
      return a.title.localeCompare(b.title, 'zh-Hans');
    });

    const outline: ClusterReportOutline = {
      mode: 'clustered',
      totalInsights: reportInsights.length,
      rawInsights: eligible.length,
      minImportance: REPORT_MIN_IMPORTANCE,
      triage: {
        enabled: triageStats.enabled,
        highKept: triageStats.highKept,
        midCandidates: triageStats.midCandidates,
        midKept: triageStats.midKept
      },
      totalClusters: clusters.length,
      shownClusters: shown,
      sections
    };

    const headline = `${formatDisplayDate(reportWindow.end, config.REPORT_TIMEZONE)} 主题聚类汇总`;
    const markdown = renderClusterReportMarkdown(outline, reportWindow, config.REPORT_TIMEZONE, headline);

    const report = await prisma.report.create({
      data: {
        periodStart: reportWindow.start,
        periodEnd: reportWindow.end,
        headline,
        content: markdown,
        outline: outline as unknown as Prisma.JsonObject,
        aiRunId: aiRun.id
      }
    });

    await prisma.aiRun.update({
      where: { id: aiRun.id },
      data: { status: AiRunStatus.COMPLETED, completedAt: new Date() }
    });
    logger.info('Report generation completed', {
      ...windowMeta,
      reportId: report.id,
      insights: insights.length,
      eligible: eligible.length,
      clusterCandidates: outline.totalInsights,
      triageEnabled: triageStats.enabled,
      triageHighKept: triageStats.highKept,
      triageMidCandidates: triageStats.midCandidates,
      triageMidKept: triageStats.midKept,
      clusters: outline.totalClusters,
      shownClusters: outline.shownClusters
    });

    return report;
  } catch (error) {
    await prisma.aiRun.update({
      where: { id: aiRun.id },
      data: {
        status: AiRunStatus.FAILED,
        error: error instanceof Error ? error.message : 'unknown error',
        completedAt: new Date()
      }
    });
    logger.error('Report generation failed', error);
    throw error;
  }
}

function renderReportMarkdown(payload: ReportPayload, window: { start: Date; end: Date }, timezone: string) {
  const lines = [
    `# ${payload.headline}`,
    `> 时间范围：${formatDisplayDate(window.start, timezone)} - ${formatDisplayDate(window.end, timezone)}`,
    '## 概览'
  ];

  const overviewEntries = Array.isArray(payload.overview) ? payload.overview : [payload.overview];
  overviewEntries.filter(Boolean).forEach((entry) => lines.push(`- ${entry}`));

  if (payload.sections?.length) {
    lines.push('## 重点洞察');
    payload.sections.forEach((section) => {
      lines.push(`### ${section.title}`);
      if (section.insight) {
        lines.push(section.insight);
      }
      if (section.items?.length) {
        section.items.forEach((item) => {
          const stars = item.importance ? `${item.importance}⭐ ` : '';
          const tags = item.tags?.length ? ` [${item.tags.join(', ')}]` : '';
          const reference = item.tweetUrl ?? item.tweetId;
          const suffix = reference ? ` (${reference})` : '';
          lines.push(`- ${stars}${item.summary}${suffix}${tags}`);
        });
      }
      if (!section.items?.length && section.tweets?.length) {
        lines.push('相关推文:');
        section.tweets.forEach((tweet) => lines.push(`- ${tweet}`));
      }
    });
  }

  if (payload.actionItems?.length) {
    lines.push('## 可执行建议');
    payload.actionItems.forEach((item, idx) => {
      if (typeof item === 'string') {
        lines.push(`${idx + 1}. ${item}`);
        return;
      }
      const ref = item.tweetId ? `（来源：${item.tweetId}）` : '';
      lines.push(`${idx + 1}. ${item.description}${ref}`);
    });
  }

  if (payload.overflow?.length) {
    lines.push('## 额外洞察');
    payload.overflow.forEach((entry) => {
      lines.push(`- ${entry.summary} (${entry.tweetId})`);
    });
  }

  return lines.join('\n\n');
}

type HighScoreEntry = {
  category: string;
  text: string;
};

function isClusterOutline(outline: unknown): outline is ClusterReportOutline {
  if (!outline || typeof outline !== 'object') {
    return false;
  }
  const candidate = outline as { mode?: unknown; sections?: unknown };
  return candidate.mode === 'clustered' && Array.isArray(candidate.sections);
}

function extractHighScoreEntries(outline: unknown): HighScoreEntry[] {
  if (!outline || typeof outline !== 'object') {
    return [];
  }

  if (isClusterOutline(outline)) {
    const entries: HighScoreEntry[] = [];
    outline.sections.forEach((section) => {
      if (!Array.isArray(section.clusters)) {
        return;
      }
      section.clusters.forEach((cluster) => {
        const peakImportance = cluster.peakImportance ?? 0;
        if (peakImportance < HIGH_PRIORITY_IMPORTANCE) {
          return;
        }
        const summary = cluster.representative?.summary?.trim();
        if (!summary) {
          return;
        }
        const category = section.title?.trim() || '其他';
        const tags = cluster.tags?.length ? ` [${cluster.tags.slice(0, 5).join(', ')}]` : '';
        const link = cluster.representative?.tweetUrl ? ` [推文](${cluster.representative.tweetUrl})` : '';
        const detail = `（${cluster.size}条 / 最高${cluster.peakImportance}⭐）`;
        entries.push({ category, text: `${summary}${detail}${link}${tags}` });
      });
    });
    return entries;
  }

  const payload = outline as ReportPayload;
  if (!Array.isArray(payload.sections)) {
    return [];
  }
  const entries: HighScoreEntry[] = [];
  payload.sections.forEach((section) => {
    if (!Array.isArray(section.items)) {
      return;
    }
    section.items.forEach((item) => {
      const importance = item.importance ?? 0;
      if (importance < HIGH_PRIORITY_IMPORTANCE) {
        return;
      }
      const summary = item.summary?.trim();
      if (!summary) {
        return;
      }
      const category = section.title?.trim() || '其他';
      const reference = item.tweetUrl ?? item.tweetId;
      const suffix = reference ? ` (${reference})` : '';
      const stars = item.importance ? `${item.importance}⭐ ` : '';
      entries.push({ category, text: `${stars}${summary}${suffix}` });
    });
  });
  return entries;
}

function normalizeSummaryText(text: string) {
  let output = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2');
  output = output.replace(/\s*\[([^\]]+)\]\s*$/, ' Tags: $1');
  return output.trim();
}

function formatHighScoreSummaryEntry(entry: HighScoreEntry) {
  const category = entry.category?.trim();
  const prefix = category ? `【${category}】` : '';
  const normalized = normalizeSummaryText(entry.text);
  return truncateText(`${prefix}${normalized}`, 180);
}

export function buildHighScoreSummaryMarkdown(report: Report, previewUrl: string) {
  const entries = extractHighScoreEntries(report.outline);
  const timeRangeLine =
    report.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('> 时间范围：')) ||
    `> 时间范围：${formatDisplayDate(report.periodStart, config.REPORT_TIMEZONE)} - ${formatDisplayDate(
      report.periodEnd,
      config.REPORT_TIMEZONE
    )}`;
  const lines = [`# ${report.headline}`, timeRangeLine, '', `高分条目：${entries.length} 条`, `预览链接：${previewUrl}`];
  return lines.join('\n');
}

function buildHighScoreReportMarkdown(report: Report) {
  const entries = extractHighScoreEntries(report.outline);
  if (!entries.length) {
    return null;
  }
  const headline = `${report.headline} 高分速览`;
  const timeRangeLine =
    report.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith('> 时间范围：')) ||
    `> 时间范围：${formatDisplayDate(report.periodStart, config.REPORT_TIMEZONE)} - ${formatDisplayDate(
      report.periodEnd,
      config.REPORT_TIMEZONE
    )}`;
  const lines = [`# ${headline}`, timeRangeLine, '', '## 重点洞察'];
  const buckets = new Map<string, string[]>();
  entries.forEach((entry) => {
    const key = entry.category?.trim() || '其他';
    const list = buckets.get(key) ?? [];
    list.push(entry.text);
    buckets.set(key, list);
  });
  for (const [category, items] of buckets.entries()) {
    lines.push('', `### ${category}`);
    items.forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join('\n');
}

export type HighScoreSendResult = {
  delivered: boolean;
  parts?: number;
  reason?: 'no-high-score' | 'high-score-channel-missing';
};

export async function sendHighScoreReport(report: Report): Promise<HighScoreSendResult> {
  const markdown = buildHighScoreReportMarkdown(report);
  if (!markdown) {
    return { delivered: false, reason: 'no-high-score' };
  }
  const result = await sendHighScoreMarkdownToTelegram(markdown);
  if (!result) {
    return { delivered: false, reason: 'high-score-channel-missing' };
  }
  return { delivered: true, parts: result.parts };
}

export async function sendReportAndNotify(report: Report | null) {
  if (!report) return null;
  logger.info('Dispatching report notification', { reportId: report.id });
  await sendMarkdownToTelegram(report.content);
  const highScoreMarkdown = buildHighScoreReportMarkdown(report);
  if (highScoreMarkdown) {
    try {
      await sendHighScoreMarkdownToTelegram(highScoreMarkdown);
    } catch (error) {
      logger.warn('High-score report notification failed', {
        reportId: report.id,
        error: getErrorMessage(error)
      });
    }
  }
  logger.info('Report notification delivered', { reportId: report.id });
  return prisma.report.update({
    where: { id: report.id },
    data: { deliveredAt: new Date(), deliveryTarget: 'telegram' }
  });
}
