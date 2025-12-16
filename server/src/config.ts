import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL missing'),
  RAPIDAPI_HOST: z.string().default('twitter-api45.p.rapidapi.com'),
  RAPIDAPI_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  DASHSCOPE_API_KEY: z.string().optional(),
  DASHSCOPE_BASE_URL: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  EMBEDDING_MODEL: z.string().default('text-embedding-v4'),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(512),
  REPORT_CLUSTER_THRESHOLD: z.coerce.number().default(0.9),
  REPORT_CLUSTER_MAX: z.coerce.number().default(0),
  TG_BOT_TOKEN: z.string().optional(),
  TG_CHAT_ID: z.string().optional(),
  REPORT_CRON_SCHEDULE: z.string().default(process.env.CRON_SCHEDULE ?? '0 3 * * *'),
  FETCH_CRON_SCHEDULE: z.string().default('*/1 * * * *'),
  CLASSIFY_CRON_SCHEDULE: z.string().default('*/5 * * * *'),
  FETCH_BATCH_SIZE: z.coerce.number().default(10),
  FETCH_COOLDOWN_HOURS: z.coerce.number().default(12),
  CLASSIFY_MIN_TWEETS: z.coerce.number().default(10),
  CLASSIFY_CONCURRENCY: z.coerce.number().default(4),
  REPORT_TIMEZONE: z.string().default('Asia/Shanghai'),
  BASE_WEB_URL: z.string().default('http://localhost:5173'),
  AI_LOCK_TTL_MS: z.coerce.number().default(60 * 60 * 1000)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const config = parsed.data;
export type AppConfig = typeof config;
