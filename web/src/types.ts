export interface Subscription {
  id: string;
  screenName: string;
  displayName?: string | null;
  lastFetchedAt?: string | null;
  createdAt: string;
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
