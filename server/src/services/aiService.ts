import OpenAI from 'openai';
import { AiRunKind, AiRunStatus, Prisma, Report, Tweet } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { chunk } from '../utils/chunk';
import { safeJsonParse } from '../utils/json';
import { formatDisplayDate, withTz } from '../utils/time';
import { sendMarkdownToTelegram } from './notificationService';

const client = config.DEEPSEEK_API_KEY
  ? new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: config.DEEPSEEK_API_KEY })
  : null;

const CLASSIFY_ALLOWED_TAGS = [
  'airdrop',
  'token',
  'defi',
  'security',
  'infrastructure',
  'narrative',
  'market',
  'funding',
  'community',
  'governance',
  'policy',
  'ecosystem'
];

const CLASSIFY_BATCH_SIZE = 6;
const CLASSIFY_CONCURRENCY = Math.max(1, config.CLASSIFY_CONCURRENCY ?? 2);
const CLASSIFY_MAX_RETRIES = 3;
const CLASSIFY_RETRY_DELAY_MS = 1500;
const REPORT_CHUNK_SIZE = 30;
const TRIAGE_CHUNK_SIZE = 40;
const TRIAGE_MAX_KEEP_PER_CHUNK = 15;
const HIGH_PRIORITY_IMPORTANCE = 4;
const MEDIUM_MIN_IMPORTANCE = 2;
const MEDIUM_MAX_IMPORTANCE = 3;

type InsightWithTweet = Prisma.TweetInsightGetPayload<{ include: { tweet: true } }>;

interface TweetInsightPayload {
  tweetId: string;
  verdict: 'ignore' | 'watch' | 'actionable';
  summary?: string;
  importance?: number;
  tags?: string[];
  suggestions?: string;
}

interface ReportSectionInsight {
  tweetId: string;
  summary: string;
  importance?: number;
  tags?: string[];
}

interface ReportActionItem {
  description: string;
  tweetId?: string;
}

interface OverflowInsight {
  tweetId: string;
  summary: string;
}

interface CondensedInsight {
  tweetId: string;
  summary: string;
  importance?: number;
  tags?: string[];
  suggestions?: string;
  verdict?: string;
  url?: string;
  author?: string;
  handle?: string;
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

function ensureClient() {
  if (!client) {
    throw new Error('DEEPSEEK_API_KEY missing, cannot call AI');
  }
  return client;
}

function defaultWindow() {
  const now = withTz(new Date(), config.REPORT_TIMEZONE);
  return {
    start: now.subtract(24, 'hour').toDate(),
    end: now.toDate()
  };
}

export async function countPendingTweets() {
  return prisma.tweet.count({
    where: {
      insights: null
    }
  });
}

export async function classifyTweets() {
  const tweets = await prisma.tweet.findMany({
    where: {
      insights: null
    },
    orderBy: { tweetedAt: 'asc' }
  });

  logger.info('Loaded pending tweets for classification', { pending: tweets.length });

  if (!tweets.length) {
    logger.info('No pending tweets found, skipping classification run');
    return { processed: 0, insights: 0 };
  }

  return runTweetClassification(tweets, { mode: 'pending' });
}

export async function classifyTweetsByIds(tweetIds: string[]) {
  if (!tweetIds.length) {
    return { processed: 0, insights: 0 };
  }

  const tweets = await prisma.tweet.findMany({
    where: {
      id: { in: tweetIds },
      insights: null
    },
    orderBy: { tweetedAt: 'asc' }
  });

  logger.info('Loaded targeted tweets for classification', {
    requested: tweetIds.length,
    pending: tweets.length
  });

  if (!tweets.length) {
    logger.info('No eligible tweets found for targeted classification');
    return { processed: 0, insights: 0 };
  }

  return runTweetClassification(tweets, { mode: 'targeted' });
}

async function runTweetClassification(tweets: Tweet[], context: Record<string, unknown> = {}) {
  const aiRun = await prisma.aiRun.create({
    data: { kind: AiRunKind.TWEET_CLASSIFY, status: AiRunStatus.RUNNING }
  });

  try {
    const batches = chunk(tweets, CLASSIFY_BATCH_SIZE);
    const tweetMap = new Map(tweets.map((tweet) => [tweet.tweetId, tweet]));
    let totalInsights = 0;
    logger.info('Tweet classification run started', {
      aiRunId: aiRun.id,
      batches: batches.length,
      pending: tweets.length,
      ...context
    });

    await runWithConcurrency(batches, CLASSIFY_CONCURRENCY, async (batch, batchIndex) => {
      logger.info('Submitting batch for AI classification', {
        aiRunId: aiRun.id,
        batchIndex: batchIndex + 1,
        batchSize: batch.length
      });
      const batchInsights = await runTweetBatchWithRetry(batch, batchIndex);
      logger.info('AI classification batch completed', {
        aiRunId: aiRun.id,
        batchIndex: batchIndex + 1,
        insights: batchInsights.length
      });
      for (const insight of batchInsights) {
        const targetTweet = tweetMap.get(insight.tweetId);
        if (!targetTweet) continue;

        await prisma.tweetInsight.upsert({
          where: { tweetId: targetTweet.tweetId },
          update: {
            verdict: insight.verdict,
            summary: insight.summary ?? null,
            importance: insight.importance ?? null,
            tags: insight.tags ?? [],
            suggestions: insight.suggestions ?? null,
            aiRunId: aiRun.id
          },
          create: {
            tweetId: targetTweet.tweetId,
            verdict: insight.verdict,
            summary: insight.summary ?? null,
            importance: insight.importance ?? null,
            tags: insight.tags ?? [],
            suggestions: insight.suggestions ?? null,
            aiRunId: aiRun.id
          }
        });

        await prisma.tweet.update({
          where: { id: targetTweet.id },
          data: { processedAt: new Date() }
        });
        totalInsights += 1;
      }
    });

    await prisma.aiRun.update({
      where: { id: aiRun.id },
      data: { status: AiRunStatus.COMPLETED, completedAt: new Date() }
    });
    logger.info('Tweet classification run completed', {
      aiRunId: aiRun.id,
      processed: tweets.length,
      insights: totalInsights,
      ...context
    });
    return { processed: tweets.length, insights: totalInsights };
  } catch (error) {
    await prisma.aiRun.update({
      where: { id: aiRun.id },
      data: {
        status: AiRunStatus.FAILED,
        error: error instanceof Error ? error.message : 'unknown error',
        completedAt: new Date()
      }
    });
    logger.error('Tweet classification failed', error);
    throw error;
  }
}

async function runTweetBatch(batch: Tweet[]): Promise<TweetInsightPayload[]> {
  const openai = ensureClient();
  const prompt = buildBatchPrompt(batch);
  const completion = await openai.chat.completions.create({
    model: 'deepseek-chat',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: '你是一名资深 Web3 情报分析官，负责每日简报，必须完整提炼所有关键推文且不能遗漏重要细节。'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  });

  const content = completion.choices?.[0]?.message?.content ?? '{}';
  const parsed = safeJsonParse<{ items: TweetInsightPayload[] }>(content);
  return parsed.items ?? [];
}

async function runTweetBatchWithRetry(batch: Tweet[], batchIndex: number) {
  let attempt = 0;
  let lastError: unknown = null;
  while (attempt < CLASSIFY_MAX_RETRIES) {
    attempt += 1;
    try {
      return await runTweetBatch(batch);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : 'unknown error';
      if (attempt >= CLASSIFY_MAX_RETRIES) {
        logger.error('AI classification batch failed after retries', {
          batchIndex: batchIndex + 1,
          attempt,
          error: message
        });
        break;
      }
      logger.warn('AI classification batch failed, retrying', {
        batchIndex: batchIndex + 1,
        attempt,
        error: message
      });
      await delay(CLASSIFY_RETRY_DELAY_MS * attempt);
    }
  }
  if (lastError) {
    throw lastError;
  }
  return [];
}

function buildBatchPrompt(batch: Tweet[]) {
  const template = {
    role: '你是每日 Web3 情报分析官，需要完整筛查所有输入推文，绝不能漏掉任何有价值的内容。',
    instructions:
      '逐条评估推文，结合作者可信度、置信度与可执行性，输出纯 JSON。若 actionable 推文过多，依然要全部单独返回，不许合并或省略。',
    outputSchema:
      '{"items": [{"tweetId": "id","verdict": "ignore|watch|actionable","summary": "一句话重点","importance": 1-5,"tags": ["airdrop","security"],"suggestions": "若需要，写出可执行建议"}]}',
    verdictRules: [
      { verdict: 'ignore', criteria: '纯情绪、重复旧闻、广告、缺乏上下文或无任何行动价值' },
      {
        verdict: 'watch',
        criteria: '潜在重要，尚需更多验证/时间，例如新品发布、资金动态、生态政策等'
      },
      {
        verdict: 'actionable',
        criteria: '可以立即采取行动的信息，如申领步骤、漏洞警报、交易窗口、治理投票等；必须配套建议'
      }
    ],
    importanceHint: '1=边缘噪音，3=值得收藏跟踪，5=高优先级立即处理。',
    tagGuide: `只允许使用以下标签，必要时可多选：${CLASSIFY_ALLOWED_TAGS.join(', ')}`,
    tweets: batch.map((tweet) => ({
      tweetId: tweet.tweetId,
      author: tweet.authorName,
      handle: tweet.authorScreen,
      text: tweet.text,
      url: tweet.tweetUrl
    }))
  };
  return JSON.stringify(template, null, 2);
}

function delay(ms: number) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  if (!items.length) {
    return;
  }
  const poolSize = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const current = nextIndex;
    if (current >= items.length) {
      return;
    }
    nextIndex += 1;
    const value = items[current];
    if (value === undefined) {
      return;
    }
    await worker(value, current);
    if (nextIndex < items.length) {
      await runNext();
    }
  }
  await Promise.all(Array.from({ length: poolSize }, () => runNext()));
}

async function selectMidPriorityInsights(insights: InsightWithTweet[]) {
  if (!insights.length) {
    return [];
  }
  const openai = ensureClient();
  const batches = chunk(insights, TRIAGE_CHUNK_SIZE);
  const keptIds = new Set<string>();

  for (const [batchIndex, batch] of batches.entries()) {
    logger.info('Running mid-priority triage batch', {
      batchIndex: batchIndex + 1,
      batchSize: batch.length
    });
    const prompt = buildTriagePrompt(batch, TRIAGE_MAX_KEEP_PER_CHUNK);
    const completion = await openai.chat.completions.create({
      model: 'deepseek-chat',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: '你是资讯编辑，需要快速筛选重要推文，按指引只选择最值得保留的条目。'
        },
        { role: 'user', content: prompt }
      ]
    });
    const content = completion.choices?.[0]?.message?.content ?? '{}';
    const parsed = safeJsonParse<{ decisions?: Array<{ tweetId: string; include: boolean }> }>(content);
    const includes = (parsed.decisions ?? []).filter((decision) => decision.include);
    includes.slice(0, TRIAGE_MAX_KEEP_PER_CHUNK).forEach((decision) => keptIds.add(decision.tweetId));
  }

  return insights.filter((insight) => keptIds.has(insight.tweetId));
}

function buildTriagePrompt(batch: InsightWithTweet[], maxKeep: number) {
  const template = {
    goal: '审阅 importance 在 2-3 的推文洞察，只保留最有价值的少量条目，其余标记为 false。',
    rules: [
      `每个 chunk 最多保留 ${maxKeep} 条，优先 actionable、具有明确行动价值或重大信号的内容。`,
      '如果内容重复、缺乏上下文或影响较小，应标记 include=false。',
      '只能使用已有的 summary / tags 做判断，不要臆测新信息。'
    ],
    outputSchema: '{"decisions":[{"tweetId":"id","include":true|false,"reason":"简短原因"}]}',
    candidates: batch.map((insight) => ({
      tweetId: insight.tweetId,
      importance: insight.importance ?? null,
      verdict: insight.verdict,
      summary: insight.summary ?? '',
      tags: insight.tags ?? [],
      suggestions: insight.suggestions ?? undefined
    }))
  };
  return JSON.stringify(template, null, 2);
}

async function summarizeSelectedInsights(insights: InsightWithTweet[]) {
  if (!insights.length) {
    return [];
  }
  const openai = ensureClient();
  const batches = chunk(insights, REPORT_CHUNK_SIZE);
  const condensed: CondensedInsight[] = [];

  for (const [batchIndex, batch] of batches.entries()) {
    logger.info('Running chunk summary batch', {
      batchIndex: batchIndex + 1,
      batchSize: batch.length
    });
    const prompt = buildChunkSummaryPrompt(batch);
    const completion = await openai.chat.completions.create({
      model: 'deepseek-chat',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: '你是资深分析官，需重新审视原文并输出精炼洞察，确保每条推文都被覆盖。'
        },
        { role: 'user', content: prompt }
      ]
    });
    const content = completion.choices?.[0]?.message?.content ?? '{}';
    const parsed = safeJsonParse<{ items?: CondensedInsight[] }>(content);
    const normalized = normalizeCondensedItems(parsed.items ?? [], batch);
    condensed.push(...normalized);
  }

  return condensed;
}

function buildChunkSummaryPrompt(batch: InsightWithTweet[]) {
  const template = {
    instructions: [
      '逐条阅读原文 text，结合已有 summary/tags，生成更精炼的一句话洞察。',
      '如果可以执行，请在 suggestions 中给出清晰动作；无法判断则省略。',
      '输出必须覆盖所有输入 tweetId，不得遗漏或合并。'
    ],
    schema:
      '{"items":[{"tweetId":"原始 id","summary":"50 字以内重点","importance":1-5,"tags":["airdrop"],"suggestions":"可选"}]}',
    tweets: batch.map((insight) => ({
      tweetId: insight.tweetId,
      importance: insight.importance ?? null,
      verdict: insight.verdict,
      summary: insight.summary ?? '',
      tags: insight.tags ?? [],
      suggestions: insight.suggestions ?? undefined,
      author: insight.tweet.authorName,
      handle: insight.tweet.authorScreen,
      url: insight.tweet.tweetUrl,
      text: insight.tweet.text
    }))
  };
  return JSON.stringify(template, null, 2);
}

function normalizeCondensedItems(items: CondensedInsight[], batch: InsightWithTweet[]) {
  const lookup = new Map(batch.map((insight) => [insight.tweetId, insight]));
  const normalized = new Map<string, CondensedInsight>();

  items.forEach((item) => {
    const source = item.tweetId ? lookup.get(item.tweetId) : undefined;
    if (!source) {
      return;
    }
    const summary = (item.summary ?? source.summary ?? source.tweet.text).trim();
    if (!summary) {
      return;
    }
    const merged: CondensedInsight = {
      tweetId: source.tweetId,
      summary,
      tags: item.tags?.length ? item.tags : source.tags ?? [],
      verdict: source.verdict,
      author: source.tweet.authorName,
      handle: source.tweet.authorScreen
    };
    const importance = item.importance ?? source.importance ?? undefined;
    if (importance !== undefined) {
      merged.importance = importance;
    }
    const suggestions = item.suggestions ?? source.suggestions ?? undefined;
    if (suggestions !== undefined) {
      merged.suggestions = suggestions;
    }
    const url = source.tweet.tweetUrl ?? undefined;
    if (url !== undefined) {
      merged.url = url;
    }
    normalized.set(source.tweetId, merged);
  });

  batch.forEach((insight) => {
    if (!normalized.has(insight.tweetId)) {
      normalized.set(insight.tweetId, fallbackCondensedInsight(insight));
    }
  });

  return Array.from(normalized.values());
}

function fallbackCondensedInsight(insight: InsightWithTweet): CondensedInsight {
  const fallback: CondensedInsight = {
    tweetId: insight.tweetId,
    summary: insight.summary ?? insight.tweet.text.slice(0, 120),
    tags: insight.tags ?? [],
    verdict: insight.verdict,
    author: insight.tweet.authorName,
    handle: insight.tweet.authorScreen
  };
  if (insight.importance !== null && insight.importance !== undefined) {
    fallback.importance = insight.importance;
  }
  if (insight.suggestions) {
    fallback.suggestions = insight.suggestions;
  }
  if (insight.tweet.tweetUrl) {
    fallback.url = insight.tweet.tweetUrl;
  }
  return fallback;
}

export async function generateReport(window = defaultWindow()) {
  const windowMeta = { start: window.start.toISOString(), end: window.end.toISOString() };
  logger.info('Report generation requested', windowMeta);
  const insights = await prisma.tweetInsight.findMany({
    where: {
      tweet: {
        tweetedAt: { gte: window.start, lte: window.end }
      },
      verdict: { not: 'ignore' }
    },
    include: { tweet: true },
    orderBy: { createdAt: 'asc' }
  });

  if (!insights.length) {
    logger.info('No insights available for report generation', windowMeta);
    return null;
  }

  const openai = ensureClient();
  const aiRun = await prisma.aiRun.create({
    data: { kind: AiRunKind.REPORT_SUMMARY, status: AiRunStatus.RUNNING }
  });

  try {
    const highPriority = insights.filter((insight) => (insight.importance ?? 0) > HIGH_PRIORITY_IMPORTANCE);
    const mediumCandidates = insights.filter((insight) => {
      const importance = insight.importance ?? 0;
      return importance >= MEDIUM_MIN_IMPORTANCE && importance <= MEDIUM_MAX_IMPORTANCE;
    });

    logger.info('Report insight pools prepared', {
      total: insights.length,
      highPriority: highPriority.length,
      mediumCandidates: mediumCandidates.length
    });

    const selectedMedium = await selectMidPriorityInsights(mediumCandidates);
    logger.info('Mid-priority triage completed', {
      mediumCandidates: mediumCandidates.length,
      selectedMedium: selectedMedium.length
    });

    const selectedSet = new Set(highPriority.map((insight) => insight.tweetId));
    selectedMedium.forEach((insight) => selectedSet.add(insight.tweetId));
    const selectedInsights = insights.filter((insight) => selectedSet.has(insight.tweetId));

    if (!selectedInsights.length) {
      logger.info('No insights qualified after triage', windowMeta);
      return null;
    }

    const condensedInsights = await summarizeSelectedInsights(selectedInsights);
    if (!condensedInsights.length) {
      logger.info('Chunk summarization produced no condensed insights', windowMeta);
      return null;
    }

    const prompt = buildReportPrompt(condensedInsights, window);

    const completion = await openai.chat.completions.create({
      model: 'deepseek-chat',
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: '你是一名专业每日情报整理师，只能输出结构化 JSON，不写段落文章。'
        },
        { role: 'user', content: prompt }
      ]
    });

    const content = completion.choices?.[0]?.message?.content ?? '{}';
    const parsed = safeJsonParse<ReportPayload>(content);
    const markdown = renderReportMarkdown(parsed, window);

    const report = await prisma.report.create({
      data: {
        periodStart: window.start,
        periodEnd: window.end,
        headline: parsed.headline,
        content: markdown,
        outline: parsed as unknown as Prisma.JsonObject,
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
      selectedInsights: selectedInsights.length,
      condensedEntries: condensedInsights.length
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

function buildReportPrompt(items: CondensedInsight[], window: { start: Date; end: Date }) {
  const template = {
    window,
    meta: {
      totalItems: items.length
    },
    instructions:
      '根据这些已精炼的推文洞察生成「每日价值信息 JSON」，保持结构化呈现并确保所有条目都被引用。',
    schema:
      '{"headline":"总标题","overview":["精炼 bullet"],"sections":[{"title":"主题","insight":"一句话总结","tweets":["tweet url 或 id"],"items":[{"tweetId":"原始 tweet id","summary":"一句话洞察","importance":1-5,"tags":["airdrop"]}]}],"actionItems":[{"description":"需要执行的事项","tweetId":"可选引用"}],"overflow":[{"tweetId":"仍未聚合的推文","summary":"一句话说明"}]}',
    reminders: [
      'overview 必须是 2-4 条 bullet，描述宏观趋势或共性结论。',
      'sections 需按主题/标签聚合，但每条 input 都要被引用在某个 section.items 或 overflow 中，禁止丢失。',
      'actionable 的洞察若有具体步骤，请写到 actionItems，并引用来源 tweetId。',
      '信息太多时，可以把不适合合并的内容放进 overflow，仍需保留关键细节。',
      'overview 中请添加一条 bullet 说明本次共保留多少条洞察（使用 meta.totalItems）。',
      '输出必须是严格 JSON，不要添加额外文本。'
    ],
    insights: items
  };
  return JSON.stringify(template, null, 2);
}

function renderReportMarkdown(payload: ReportPayload, window: { start: Date; end: Date }) {
  const lines = [
    `# ${payload.headline}`,
    `> 时间范围：${formatDisplayDate(window.start, config.REPORT_TIMEZONE)} - ${formatDisplayDate(
      window.end,
      config.REPORT_TIMEZONE
    )}`,
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
          lines.push(`- ${stars}${item.summary} (${item.tweetId})${tags}`);
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

export async function sendReportAndNotify(report: Report | null) {
  if (!report) return null;
  logger.info('Dispatching report notification', { reportId: report.id });
  await sendMarkdownToTelegram(report.content);
  logger.info('Report notification delivered', { reportId: report.id });
  return prisma.report.update({
    where: { id: report.id },
    data: { deliveredAt: new Date(), deliveryTarget: 'telegram' }
  });
}
