export type BackgroundJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface BackgroundJobSummary {
  id: string;
  type: string;
  status: BackgroundJobStatus;
  attempts: number;
  maxAttempts: number;
  scheduledAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  completedAt: string | null;
  lastError: string | null;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface JobEnqueueResponse {
  job: BackgroundJobSummary;
  created: boolean;
  message?: string;
}

export interface ClassificationJobResponse {
  job?: BackgroundJobSummary;
  created?: boolean;
  skipped?: boolean;
  reason?: 'none-pending' | 'below-threshold';
  pending: number;
  threshold?: number;
}

export type SubscriptionStatus = 'SUBSCRIBED' | 'UNSUBSCRIBED';

export interface Subscription {
  id: string;
  screenName: string;
  displayName?: string | null;
  status?: SubscriptionStatus;
  unsubscribedAt?: string | null;
  lastFetchedAt?: string | null;
  createdAt: string;
}

export interface SubscriptionTweetStats {
  subscriptionId: string;
  tweetsTotal: number;
  scoredTweets: number;
  avgImportance: number | null;
  highScoreTweets: number;
  highScoreRatio: number | null;
  firstTweetedAt: string | null;
  lastTweetedAt: string | null;
  avgTweetsPerDay: number | null;
}

export interface SubscriptionStatsResponse {
  totals: { total: number; subscribed: number; unsubscribed: number };
  highScoreMinImportance: number;
  items: SubscriptionTweetStats[];
}

export interface AutoUnsubscribeCandidate {
  subscriptionId: string;
  screenName: string;
  status: SubscriptionStatus;
  desiredStatus: SubscriptionStatus;
  action: 'unsubscribe' | 'resubscribe';
  avgImportance: number | null;
  scoredTweets: number;
  highScoreTweets: number;
  highScoreRatio: number | null;
  matchedAvg: boolean;
  matchedHighCount: boolean;
  matchedHighRatio: boolean;
  decision: 'keep' | 'drop';
}

export interface AutoUnsubscribeResponse {
  dryRun: boolean;
  thresholds: {
    minAvgImportance: number;
    minHighScoreTweets: number;
    minHighScoreRatio: number;
    highScoreMinImportance: number;
  };
  evaluated: number;
  willUnsubscribe: number;
  willResubscribe: number;
  updatedUnsubscribed: number;
  updatedResubscribed: number;
  candidates: AutoUnsubscribeCandidate[];
}

export interface FetchResult {
  subscriptionId: string;
  screenName: string;
  processed: number;
  inserted: number;
  error?: string;
  skipped?: boolean;
  reason?: string;
}

export interface NotificationConfig {
  tgBotToken: string | null;
  tgChatId: string | null;
  tgMessageThreadId: string | null;
}

export interface TelegramTestResult {
  delivered: boolean;
  text: string;
  messageThreadId: number | null;
  chatId: string;
}

export interface ReportSummary {
  id: string;
  headline: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  deliveredAt?: string | null;
}

export interface ReportDetail extends ReportSummary {
  content: string;
  outline?: unknown | null;
}

export interface TweetInsight {
  verdict: string;
  summary?: string | null;
  importance?: number | null;
  tags?: string[] | null;
  suggestions?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TweetRecord {
  id: string;
  tweetId: string;
  subscriptionId: string;
  authorName: string;
  authorScreen: string;
  text: string;
  tweetUrl?: string | null;
  tweetedAt: string;
  createdAt: string;
  processedAt?: string | null;
  insights?: TweetInsight | null;
}

export interface TweetListResponse {
  items: TweetRecord[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface SubscriptionImportUser {
  subscriptionId: string;
  screenName: string;
  displayName: string | null;
  created: boolean;
}

export interface SubscriptionImportResult {
  fetched: number;
  created: number;
  existing: number;
  skipped: number;
  nextCursor: string | null;
  hasMore: boolean;
  users: SubscriptionImportUser[];
}
