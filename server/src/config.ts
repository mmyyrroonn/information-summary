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
  SOCIAL_DIGEST_PROVIDER: z.string().default('deepseek'),
  SOCIAL_DIGEST_DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  SOCIAL_DIGEST_DASHSCOPE_MODEL: z.string().default('qwen3-max'),
  EMBEDDING_MODEL: z.string().default('text-embedding-v4'),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(512),
  ROUTING_CACHE_WINDOW_DAYS_DEFAULT: z.coerce.number().default(120),
  ROUTING_CACHE_SAMPLE_PER_TAG_DEFAULT: z.coerce.number().default(200),
  REPORT_CLUSTER_THRESHOLD: z.coerce.number().default(0.86),
  REPORT_CLUSTER_CROSS_TAG_BUMP: z.coerce.number().default(0.04),
  REPORT_CLUSTER_MAX: z.coerce.number().default(0),
  REPORT_MIN_IMPORTANCE: z.coerce.number().default(2),
  REPORT_MID_TRIAGE_ENABLED: z.coerce.boolean().default(true),
  REPORT_MID_TRIAGE_CONCURRENCY: z.coerce.number().default(1),
  REPORT_MID_TRIAGE_CHUNK_SIZE: z.coerce.number().default(30),
  REPORT_MID_TRIAGE_MAX_KEEP_PER_CHUNK: z.coerce.number().default(15),
  TG_BOT_TOKEN: z.string().optional(),
  TG_CHAT_ID: z.string().optional(),
  TG_MESSAGE_THREAD_ID: z.string().optional(),
  TG_HIGH_SCORE_MESSAGE_THREAD_ID: z.string().optional(),
  FETCH_CRON_SCHEDULE: z.string().default('*/1 * * * *'),
  CLASSIFY_CRON_SCHEDULE: z.string().default('*/5 * * * *'),
  FETCH_BATCH_SIZE: z.coerce.number().default(10),
  FETCH_COOLDOWN_HOURS: z.coerce.number().default(12),
  CLASSIFY_MIN_TWEETS: z.coerce.number().default(10),
  CLASSIFY_TAG_MIN_TWEETS: z.coerce.number().default(10),
  CLASSIFY_TAG_MAX_WAIT_HOURS: z.coerce.number().default(2),
  CLASSIFY_CONCURRENCY: z.coerce.number().default(6),
  REPORT_TIMEZONE: z.string().default('Asia/Shanghai'),
  BASE_WEB_URL: z.string().default('http://localhost:5173'),
  AI_LOCK_TTL_MS: z.coerce.number().default(60 * 60 * 1000),
  GITHUB_PAGES_REPO_PATH: z.string().optional(),
  GITHUB_PAGES_BRANCH: z.string().default('main'),
  GITHUB_PAGES_REPORT_DIR: z.string().default('reports'),
  GITHUB_PAGES_INDEX_FILE: z.string().default('index.md'),
  GITHUB_PAGES_BASE_URL: z.string().optional(),
  GITHUB_PAGES_SSH_KEY_PATH: z.string().optional(),
  GITHUB_PAGES_SSH_COMMAND: z.string().optional(),
  GITHUB_PAGES_COMMIT_NAME: z.string().default('report-bot'),
  GITHUB_PAGES_COMMIT_EMAIL: z.string().default('report-bot@local'),
  GITHUB_PAGES_AUTO_PUBLISH: z.coerce.boolean().default(false)
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const config = parsed.data;
export type AppConfig = typeof config;
