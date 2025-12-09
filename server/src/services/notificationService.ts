import axios from 'axios';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';

export async function getNotificationConfig() {
  const dbConfig = await prisma.notificationConfig.findUnique({ where: { id: 1 } });
  return {
    tgBotToken: dbConfig?.tgBotToken ?? config.TG_BOT_TOKEN ?? null,
    tgChatId: dbConfig?.tgChatId ?? config.TG_CHAT_ID ?? null
  };
}

export async function updateNotificationConfig(payload: { tgBotToken: string | null; tgChatId: string | null }) {
  await prisma.notificationConfig.upsert({
    where: { id: 1 },
    create: { id: 1, tgBotToken: payload.tgBotToken, tgChatId: payload.tgChatId },
    update: { tgBotToken: payload.tgBotToken, tgChatId: payload.tgChatId }
  });
  return getNotificationConfig();
}

export async function sendMarkdownToTelegram(markdown: string) {
  const cfg = await getNotificationConfig();
  if (!cfg.tgBotToken || !cfg.tgChatId) {
    logger.warn('Telegram config missing, skipping push');
    return null;
  }

  await axios.post(`https://api.telegram.org/bot${cfg.tgBotToken}/sendMessage`, {
    chat_id: cfg.tgChatId,
    text: markdown,
    parse_mode: 'Markdown'
  });

  return { delivered: true };
}
