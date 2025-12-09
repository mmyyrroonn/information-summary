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

interface TweetInsightPayload {
  tweetId: string;
  verdict: 'ignore' | 'watch' | 'actionable';
  summary?: string;
  importance?: number;
  tags?: string[];
  suggestions?: string;
}

interface ReportPayload {
  headline: string;
  overview: string;
  sections?: Array<{ title: string; insight: string; tweets?: string[] }>;
  actionItems?: string[];
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

export async function countPendingTweets(window = defaultWindow()) {
  return prisma.tweet.count({
    where: {
      tweetedAt: { gte: window.start, lte: window.end },
      insights: null
    }
  });
}

export async function classifyTweets(window = defaultWindow()) {
  const tweets = await prisma.tweet.findMany({
    where: {
      tweetedAt: { gte: window.start, lte: window.end },
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
        content: '你是一名资深 Web3/策略交易情报官，擅长筛选高价值推特信息。'
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
    instructions:
      '请对下面的推文逐条进行分析，判断其信息价值。输出 JSON，格式为 {"items": [{"tweetId": "id", "verdict": "ignore|watch|actionable", "summary": "一句话总结", "importance": 1-5, "tags": ["kols", "airdrop"], "suggestions": "若有行动建议"}]}。不要输出多余文字。',
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
          content: '你是一名专业周报撰稿人，擅长把碎片信息整理成结构化洞察。'
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
      '根据这些推文洞察，生成结构化周报 JSON：{"headline": "总标题", "overview": "整体观察", "sections": [{"title": "主题", "insight": "描述", "tweets": ["tweet url 或 id"]}], "actionItems": ["..." ] }。保持精炼中文。只输出 JSON。',
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
    '## 概览',
    payload.overview
  ];

  if (payload.sections?.length) {
    lines.push('## 重点洞察');
    payload.sections.forEach((section) => {
      lines.push(`### ${section.title}`);
      lines.push(section.insight);
      if (section.tweets?.length) {
        lines.push('相关推文:');
        section.tweets.forEach((tweet) => lines.push(`- ${tweet}`));
      }
    });
  }

  if (payload.actionItems?.length) {
    lines.push('## 可执行建议');
    payload.actionItems.forEach((item, idx) => lines.push(`${idx + 1}. ${item}`));
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
