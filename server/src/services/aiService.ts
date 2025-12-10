import OpenAI from 'openai';
import { AiRunKind, AiRunStatus, Prisma, Report, Tweet } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { chunk } from '../utils/chunk';
import { safeJsonParse } from '../utils/json';
import { endOfDay, formatDisplayDate, startOfDay } from '../utils/time';
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
  const now = new Date();
  return {
    start: startOfDay(now, config.REPORT_TIMEZONE).toDate(),
    end: endOfDay(now, config.REPORT_TIMEZONE).toDate()
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

  if (!tweets.length) {
    return { processed: 0, insights: 0 };
  }

  const aiRun = await prisma.aiRun.create({
    data: { kind: AiRunKind.TWEET_CLASSIFY, status: AiRunStatus.RUNNING }
  });

  try {
    const batches = chunk(tweets, 6);
    let totalInsights = 0;

    for (const batch of batches) {
      const batchInsights = await runTweetBatch(batch);
      for (const insight of batchInsights) {
        const targetTweet = tweets.find((t) => t.tweetId === insight.tweetId);
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
    }

    await prisma.aiRun.update({
      where: { id: aiRun.id },
      data: { status: AiRunStatus.COMPLETED, completedAt: new Date() }
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

export async function generateReport(window = defaultWindow()) {
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
    return null;
  }

  const openai = ensureClient();
  const aiRun = await prisma.aiRun.create({
    data: { kind: AiRunKind.REPORT_SUMMARY, status: AiRunStatus.RUNNING }
  });

  try {
    const formatted = insights.map((insight) =>
      mapInsight({
        tweetId: insight.tweetId,
        verdict: insight.verdict,
        summary: insight.summary,
        importance: insight.importance,
        tags: insight.tags,
        suggestions: insight.suggestions,
        text: insight.tweet.text,
        author: insight.tweet.authorName,
        handle: insight.tweet.authorScreen,
        url: insight.tweet.tweetUrl
      })
    );
    const prompt = buildReportPrompt(formatted, window);

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

function buildReportPrompt(items: Array<ReturnType<typeof mapInsight>>, window: { start: Date; end: Date }) {
  const template = {
    window,
    instructions:
      '根据这些推文洞察生成「每日价值信息 JSON」，保持结构化呈现并确保所有高价值内容都被收录。',
    schema:
      '{"headline":"总标题","overview":["精炼 bullet"],"sections":[{"title":"主题","insight":"一句话总结","tweets":["tweet url 或 id"],"items":[{"tweetId":"原始 tweet id","summary":"一句话洞察","importance":1-5,"tags":["airdrop"]}]}],"actionItems":[{"description":"需要执行的事项","tweetId":"可选引用"}],"overflow":[{"tweetId":"仍未聚合的推文","summary":"一句话说明"}]}',
    reminders: [
      'overview 必须是 2-4 条 bullet，描述宏观趋势或共性结论。',
      'sections 需按主题/标签聚合，但每条 input 都要被引用在某个 section.items 或 overflow 中，禁止丢失。',
      'actionable 的洞察若有具体步骤，请写到 actionItems，并引用来源 tweetId。',
      '信息太多时，可以把不适合合并的内容放进 overflow，仍需保留关键细节。',
      '输出必须是严格 JSON，不要添加额外文本。'
    ],
    insights: items
  };
  return JSON.stringify(template, null, 2);
}

function mapInsight(insight: {
  tweetId: string;
  verdict: string;
  summary: string | null;
  importance: number | null;
  tags: string[] | null;
  suggestions: string | null;
  text: string;
  author: string;
  handle: string;
  url: string | null;
}) {
  return {
    tweetId: insight.tweetId,
    verdict: insight.verdict,
    summary: insight.summary ?? '',
    importance: insight.importance ?? undefined,
    tags: insight.tags ?? [],
    suggestions: insight.suggestions ?? undefined,
    text: insight.text,
    author: insight.author,
    handle: insight.handle,
    url: insight.url ?? undefined
  };
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
  await sendMarkdownToTelegram(report.content);
  return prisma.report.update({
    where: { id: report.id },
    data: { deliveredAt: new Date(), deliveryTarget: 'telegram' }
  });
}
