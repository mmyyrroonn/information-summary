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

export interface RoutingEmbeddingRefreshResult {
  updated: boolean;
  reason?: 'embeddings-disabled' | 'insufficient-samples';
  windowDays: number;
  samplePerTag: number;
  totalSamples?: number;
  tagSampleCounts?: Record<string, number>;
  model?: string;
  dimensions?: number;
  updatedAt?: string;
}

export interface RoutingEmbeddingCacheSummary {
  updatedAt: string;
  model: string;
  dimensions: number;
  windowDays: number;
  samplePerTag: number;
  tagSampleCounts: Record<string, number>;
  tagMetrics: Record<string, RoutingEmbeddingTagMetric>;
  totalSamples: number;
  negativeSampleCount: number;
}

export interface RoutingEmbeddingTagMetric {
  sampleCount: number;
  meanSim: number | null;
  p75Sim: number | null;
  negativeSim: number | null;
  negativeDistance: number | null;
}

export interface RoutingTagListResponse {
  tags: Array<{ tag: string; label: string }>;
}

export type SubscriptionStatus = 'SUBSCRIBED' | 'UNSUBSCRIBED';

export interface Subscription {
  id: string;
  screenName: string;
  displayName?: string | null;
  tags?: string[];
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
    protectNewSubscriptions: boolean;
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
  tgHighScoreMessageThreadId: string | null;
}

export interface TelegramTestResult {
  delivered: boolean;
  text: string;
  messageThreadId: number | null;
  chatId: string;
}

export interface HighScoreSendResult {
  delivered: boolean;
  parts?: number;
}

export interface TagOption {
  tag: string;
  count: number;
}

export interface TagOptionsResponse {
  tweetTags: TagOption[];
  authorTags: TagOption[];
}

export interface ReportSummary {
  id: string;
  headline: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  publishedAt?: string | null;
  deliveredAt?: string | null;
  profileId?: string | null;
}

export interface ReportDetail extends ReportSummary {
  content: string;
  outline?: unknown | null;
}

export interface ReportPublishResult {
  publishedAt: string;
  url?: string | null;
  indexUrl?: string | null;
}

export interface SocialDigestResult {
  content: string;
  bullets: string[];
  usedItems: number;
  totalItems: number;
  periodStart: string;
  periodEnd: string;
}

export interface SocialImagePromptResult {
  prompt: string;
  usedItems: number;
  totalItems: number;
  periodStart: string;
  periodEnd: string;
}

export type ReportProfileGroupBy = 'cluster' | 'tag' | 'author';

export interface ReportProfile {
  id: string;
  name: string;
  enabled: boolean;
  scheduleCron: string;
  windowHours: number;
  timezone: string;
  includeTweetTags: string[];
  excludeTweetTags: string[];
  includeAuthorTags: string[];
  excludeAuthorTags: string[];
  minImportance: number;
  verdicts: string[];
  groupBy: ReportProfileGroupBy;
  aiFilterEnabled: boolean;
  aiFilterPrompt?: string | null;
  aiFilterMaxKeepPerChunk?: number | null;
  createdAt: string;
  updatedAt: string;
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
  routingStatus?: string | null;
  routingTag?: string | null;
  routingScore?: number | null;
  routingMargin?: number | null;
  routingReason?: string | null;
  routedAt?: string | null;
  llmQueuedAt?: string | null;
  abandonedAt?: string | null;
  abandonReason?: string | null;
  embeddingScore?: number | null;
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

export interface TweetStatsResponse {
  range: {
    startTime: string | null;
    endTime: string | null;
    subscriptionId: string | null;
  };
  totals: {
    totalTweets: number;
    scoredTweets: number;
    viewTweets: number;
    highScoreMinImportance: number;
    highScoreTweets: number;
    avgLength: number | null;
    medianLength: number | null;
    p90Length: number | null;
    avgViews: number | null;
    medianViews: number | null;
    p90Views: number | null;
    avgImportance: number | null;
    lengthImportanceCorrelation: number | null;
  };
  lengthBuckets: Array<{
    label: string;
    min: number;
    max: number | null;
    count: number;
    avgLength: number | null;
    avgImportance: number | null;
    avgViews: number | null;
  }>;
  viewBuckets: Array<{
    label: string;
    min: number;
    max: number | null;
    count: number;
    avgViews: number | null;
    avgImportance: number | null;
    avgLength: number | null;
  }>;
  lengthByImportance: Array<{
    importance: number;
    count: number;
    avgLength: number | null;
    minLength: number | null;
    maxLength: number | null;
    medianLength: number | null;
    p90Length: number | null;
    avgViews: number | null;
  }>;
  scoreLengthMatrix: {
    buckets: Array<{ label: string; min: number; max: number | null }>;
    rows: Array<{ importance: number; counts: number[]; total: number; avgLength: number | null; avgViews: number | null }>;
  };
  scoreViewMatrix: {
    buckets: Array<{ label: string; min: number; max: number | null }>;
    rows: Array<{ importance: number; counts: number[]; total: number; avgViews: number | null }>;
  };
  verdictStats: Array<{
    verdict: string;
    count: number;
    avgLength: number | null;
    avgImportance: number | null;
    avgViews: number | null;
  }>;
  tagStats: Array<{
    tag: string;
    count: number;
    avgLength: number | null;
    avgImportance: number | null;
    avgViews: number | null;
    highScoreRatio: number | null;
  }>;
  highScoreProfile: {
    minImportance: number;
    count: number;
    ratio: number | null;
    avgLength: number | null;
    medianLength: number | null;
    p90Length: number | null;
    viewCount: number;
    avgViews: number | null;
    medianViews: number | null;
    p90Views: number | null;
    avgTagsPerTweet: number | null;
    suggestionRate: number | null;
    summaryRate: number | null;
    verdicts: Array<{ verdict: string; count: number; share: number }>;
    tags: Array<{ tag: string; count: number; share: number }>;
    authors: Array<{ author: string; count: number; share: number }>;
    languages: Array<{ lang: string; count: number; share: number }>;
    lengthBuckets: Array<{ label: string; count: number; share: number }>;
  };
}

export interface TweetRoutingStatsResponse {
  range: {
    startTime: string | null;
    endTime: string | null;
    subscriptionId: string | null;
  };
  totals: {
    totalTweets: number;
    embeddingHigh: number;
    embeddingLow: number;
    llmTotal: number;
    llmRouted: number;
    llmQueued: number;
    llmCompleted: number;
    pending: number;
    ignoredOther: number;
  };
}
