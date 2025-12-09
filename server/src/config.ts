import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL missing'),
  RAPIDAPI_HOST: z.string().default('twitter-api45.p.rapidapi.com'),
  RAPIDAPI_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  TG_BOT_TOKEN: z.string().optional(),
  TG_CHAT_ID: z.string().optional(),
  REPORT_CRON_SCHEDULE: z.string().default(process.env.CRON_SCHEDULE ?? '0 3 * * *'),
  FETCH_CRON_SCHEDULE: z.string().default('*/30 * * * *'),
  CLASSIFY_CRON_SCHEDULE: z.string().default('*/20 * * * *'),
  FETCH_BATCH_SIZE: z.coerce.number().default(5),
  FETCH_COOLDOWN_HOURS: z.coerce.number().default(12),
  CLASSIFY_MIN_TWEETS: z.coerce.number().default(10),
  REPORT_TIMEZONE: z.string().default('Asia/Shanghai'),
  BASE_WEB_URL: z.string().default('http://localhost:5173')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const config = parsed.data;
export type AppConfig = typeof config;
