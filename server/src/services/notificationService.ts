import axios from 'axios';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';

const TELEGRAM_ITEMS_PER_MESSAGE = 5;
const LIST_ITEM_REGEX = /^\s*(?:[-*]\s+|\d+\.\s+)/;
const REPORT_SECTION_TITLES = new Set(['分类', '重点洞察', '额外洞察']);

type ReportEntry = {
  category: string;
  text: string;
};

function parseMessageThreadId(value?: string | null) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeItemText(text: string) {
  let output = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1: $2');
  output = output.replace(/\s*\[([^\]]+)\]\s*$/, ' Tags: $1');
  return output.trim();
}

function extractReportEntries(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  let headline = '';
  let timeRange = '';
  let currentSection = '';
  let currentCategory = '';
  let allowItems = false;
  const entries: ReportEntry[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('# ')) {
      headline = line.replace(/^#\s+/, '').trim();
      continue;
    }

    if (line.startsWith('> ')) {
      const content = line.replace(/^>\s*/, '').trim();
      if (content.startsWith('时间范围：')) {
        timeRange = content;
      }
      continue;
    }

    const headingMatch = line.match(/^(#{2,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 0;
      const title = (headingMatch[2] ?? '').trim();
      if (level === 2) {
        currentSection = title;
        currentCategory = title;
        allowItems = REPORT_SECTION_TITLES.has(title);
      } else if (level === 3) {
        currentCategory = title;
      }
      continue;
    }

    if (LIST_ITEM_REGEX.test(rawLine)) {
      if (!allowItems) {
        continue;
      }
      const text = rawLine.replace(LIST_ITEM_REGEX, '').trim();
      if (!text) {
        continue;
      }
      entries.push({
        category: currentCategory || currentSection || 'Misc',
        text: normalizeItemText(text)
      });
    }
  }

  return { headline, timeRange, entries };
}

function buildTelegramMessages(markdown: string, itemsPerMessage: number) {
  const { headline, timeRange, entries } = extractReportEntries(markdown);
  if (!entries.length) {
    return [markdown.trim()].filter(Boolean);
  }

  const grouped = new Map<string, string[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.category) ?? [];
    bucket.push(entry.text);
    grouped.set(entry.category, bucket);
  }

  const messages: string[] = [];
  for (const [category, items] of grouped.entries()) {
    for (let i = 0; i < items.length; i += itemsPerMessage) {
      const slice = items.slice(i, i + itemsPerMessage);
      const header: string[] = [];
      if (headline) {
        header.push(headline);
      }
      if (timeRange) {
        header.push(timeRange);
      }
      header.push(`Category: ${category}`);
      const body = slice.map((item, idx) => `${idx + 1}. ${item}`).join('\n\n');
      messages.push(`${header.join('\n')}\n\n${body}`.trim());
    }
  }

  return messages;
}

export async function getNotificationConfig() {
  const dbConfig = await prisma.notificationConfig.findUnique({ where: { id: 1 } });
  return {
    tgBotToken: dbConfig?.tgBotToken ?? config.TG_BOT_TOKEN ?? null,
    tgChatId: dbConfig?.tgChatId ?? config.TG_CHAT_ID ?? null,
    tgMessageThreadId: dbConfig?.tgMessageThreadId ?? config.TG_MESSAGE_THREAD_ID ?? null
  };
}

export async function updateNotificationConfig(payload: {
  tgBotToken: string | null;
  tgChatId: string | null;
  tgMessageThreadId: string | null;
}) {
  await prisma.notificationConfig.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      tgBotToken: payload.tgBotToken,
      tgChatId: payload.tgChatId,
      tgMessageThreadId: payload.tgMessageThreadId
    },
    update: {
      tgBotToken: payload.tgBotToken,
      tgChatId: payload.tgChatId,
      tgMessageThreadId: payload.tgMessageThreadId
    }
  });
  return getNotificationConfig();
}

export async function sendMarkdownToTelegram(markdown: string) {
  const cfg = await getNotificationConfig();
  if (!cfg.tgBotToken || !cfg.tgChatId) {
    logger.warn('Telegram config missing, skipping push');
    return null;
  }

  const messageThreadId = parseMessageThreadId(cfg.tgMessageThreadId);
  const messages = buildTelegramMessages(markdown, TELEGRAM_ITEMS_PER_MESSAGE).filter((message) => message.trim());
  for (const message of messages) {
    const threadPayload = messageThreadId === null ? {} : { message_thread_id: messageThreadId };
    await axios.post(`https://api.telegram.org/bot${cfg.tgBotToken}/sendMessage`, {
      chat_id: cfg.tgChatId,
      text: message,
      ...threadPayload
    });
  }

  return { delivered: true, parts: messages.length };
}

export async function sendTestTelegramMessage(message?: string) {
  const cfg = await getNotificationConfig();
  if (!cfg.tgBotToken || !cfg.tgChatId) {
    throw new Error('Telegram config missing');
  }

  const messageThreadId = parseMessageThreadId(cfg.tgMessageThreadId);
  const text = message?.trim() || `Telegram test message ${new Date().toISOString()}`;
  const payload: Record<string, unknown> = {
    chat_id: cfg.tgChatId,
    text
  };
  if (messageThreadId !== null) {
    payload.message_thread_id = messageThreadId;
  }
  await axios.post(`https://api.telegram.org/bot${cfg.tgBotToken}/sendMessage`, payload);

  return { delivered: true, text, messageThreadId, chatId: cfg.tgChatId };
}
