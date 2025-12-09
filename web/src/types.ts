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
