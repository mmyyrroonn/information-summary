import type {
  Subscription,
  SubscriptionStatus,
  NotificationConfig,
  TelegramTestResult,
  HighScoreSendResult,
  ReportDetail,
  ReportSummary,
  ReportPublishResult,
  ReportProfile,
  ReportProfileGroupBy,
  FetchResult,
  TweetListResponse,
  SubscriptionImportResult,
  SubscriptionStatsResponse,
  AutoUnsubscribeResponse,
  BackgroundJobSummary,
  BackgroundJobStatus,
  JobEnqueueResponse,
  ClassificationJobResponse,
  RoutingEmbeddingCacheSummary,
  RoutingTagListResponse,
  TagOptionsResponse,
  TweetStatsResponse
} from './types';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api';

async function request<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });

  if (!response.ok) {
    const message = await safeError(response);
    throw new Error(message);
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
}

async function safeError(response: Response) {
  try {
    const body = await response.json();
    return body.message || response.statusText;
  } catch {
    return response.statusText;
  }
}

interface ApiClient {
  listSubscriptions: () => Promise<Subscription[]>;
  createSubscription: (payload: { screenName: string; displayName?: string }) => Promise<Subscription>;
  deleteSubscription: (id: string) => Promise<void>;
  updateSubscriptionStatus: (id: string, status: SubscriptionStatus) => Promise<Subscription>;
  fetchSubscription: (id: string, options?: { force?: boolean; allowUnsubscribed?: boolean }) => Promise<FetchResult>;
  getSubscriptionStats: () => Promise<SubscriptionStatsResponse>;
  autoUnsubscribe: (payload?: {
    minAvgImportance?: number;
    minHighScoreTweets?: number;
    minHighScoreRatio?: number;
    highScoreMinImportance?: number;
    protectNewSubscriptions?: boolean;
    dryRun?: boolean;
  }) => Promise<AutoUnsubscribeResponse>;
  importListMembers: (payload: { listId: string; cursor?: string }) => Promise<SubscriptionImportResult>;
  importFollowingUsers: (payload: { screenName?: string; userId?: string; cursor?: string }) => Promise<SubscriptionImportResult>;
  runFetchTask: () => Promise<JobEnqueueResponse>;
  runAnalyzeTask: () => Promise<ClassificationJobResponse>;
  getRoutingEmbeddingCacheSummary: () => Promise<RoutingEmbeddingCacheSummary | null>;
  listRoutingTags: () => Promise<RoutingTagListResponse>;
  refreshRoutingEmbeddingCache: (payload?: { windowDays?: number; samplePerTag?: number }) => Promise<JobEnqueueResponse>;
  refreshRoutingEmbeddingCacheTag: (tag: string) => Promise<JobEnqueueResponse>;
  runReportTask: (payload: { notify: boolean; profileId?: string; windowEnd?: string }) => Promise<JobEnqueueResponse>;
  getNotificationConfig: () => Promise<NotificationConfig>;
  updateNotificationConfig: (payload: NotificationConfig) => Promise<NotificationConfig>;
  sendTelegramTest: (payload?: { message?: string }) => Promise<TelegramTestResult>;
  sendHighScoreReport: (id: string) => Promise<HighScoreSendResult>;
  listTagOptions: (params?: { limit?: number }) => Promise<TagOptionsResponse>;
  getDefaultReportProfile: () => Promise<ReportProfile>;
  listReports: (params?: { profileId?: string; limit?: number }) => Promise<ReportSummary[]>;
  getReport: (id: string) => Promise<ReportDetail>;
  sendReport: (id: string) => Promise<unknown>;
  publishReport: (id: string) => Promise<ReportPublishResult>;
  generateSocialDigest: (
    id: string,
    payload?: { prompt?: string; maxItems?: number; includeTweetText?: boolean }
  ) => Promise<JobEnqueueResponse>;
  listReportProfiles: () => Promise<ReportProfile[]>;
  createReportProfile: (payload: ReportProfileCreatePayload) => Promise<ReportProfile>;
  updateReportProfile: (id: string, payload: ReportProfileUpdatePayload) => Promise<ReportProfile>;
  deleteReportProfile: (id: string) => Promise<void>;
  runReportProfile: (id: string, payload?: { notify?: boolean; windowEnd?: string }) => Promise<JobEnqueueResponse>;
  listTweets: (params?: {
    page?: number;
    pageSize?: number;
    sort?: 'newest' | 'oldest' | 'priority';
    routing?: 'default' | 'ignored' | 'all';
    routingTag?: string;
    routingScoreMin?: number;
    routingScoreMax?: number;
    subscriptionId?: string;
    startTime?: string;
    endTime?: string;
    q?: string;
    importanceMin?: number;
    importanceMax?: number;
  }) => Promise<TweetListResponse>;
  analyzeTweets: (tweetIds: string[]) => Promise<{ processed: number; insights: number }>;
  getTweetStats: (params?: {
    subscriptionId?: string;
    startTime?: string;
    endTime?: string;
    highScoreMinImportance?: number;
    tagLimit?: number;
    authorLimit?: number;
  }) => Promise<TweetStatsResponse>;
  listJobs: (params?: { type?: string; status?: BackgroundJobStatus; limit?: number }) => Promise<BackgroundJobSummary[]>;
  getJob: (id: string) => Promise<BackgroundJobSummary>;
  deleteJob: (id: string) => Promise<void>;
}

type ReportProfileBasePayload = {
  name: string;
  enabled?: boolean;
  scheduleCron: string;
  windowHours: number;
  timezone?: string;
  includeTweetTags?: string[];
  excludeTweetTags?: string[];
  includeAuthorTags?: string[];
  excludeAuthorTags?: string[];
  minImportance?: number;
  verdicts?: string[];
  groupBy?: ReportProfileGroupBy;
  aiFilterEnabled?: boolean;
  aiFilterPrompt?: string | null;
  aiFilterMaxKeepPerChunk?: number | null;
};

type ReportProfileCreatePayload = ReportProfileBasePayload;
type ReportProfileUpdatePayload = Partial<ReportProfileBasePayload>;

export const api: ApiClient = {
  listSubscriptions: () => request<Subscription[]>('/subscriptions'),
  createSubscription: (payload) => request<Subscription>('/subscriptions', { method: 'POST', body: JSON.stringify(payload) }),
  deleteSubscription: (id) => request<null>(`/subscriptions/${id}`, { method: 'DELETE' }).then(() => undefined),
  updateSubscriptionStatus: (id, status) =>
    request<Subscription>(`/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  fetchSubscription: (id, options = {}) =>
    request<FetchResult>(`/subscriptions/${id}/fetch`, {
      method: 'POST',
      body: JSON.stringify({
        ...(typeof options.force === 'boolean' ? { force: options.force } : {}),
        ...(typeof options.allowUnsubscribed === 'boolean' ? { allowUnsubscribed: options.allowUnsubscribed } : {})
      })
    }),
  getSubscriptionStats: () => request<SubscriptionStatsResponse>('/subscriptions/stats'),
  autoUnsubscribe: (payload = {}) =>
    request<AutoUnsubscribeResponse>('/subscriptions/auto-unsubscribe', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  importListMembers: ({ listId, cursor }) =>
    request<SubscriptionImportResult>('/subscriptions/import/list', {
      method: 'POST',
      body: JSON.stringify({ listId, ...(cursor ? { cursor } : {}) })
    }),
  importFollowingUsers: ({ screenName, userId, cursor }) =>
    request<SubscriptionImportResult>('/subscriptions/import/following', {
      method: 'POST',
      body: JSON.stringify({
        ...(screenName ? { screenName } : {}),
        ...(userId ? { userId } : {}),
        ...(cursor ? { cursor } : {})
      })
    }),
  runFetchTask: () =>
    request<JobEnqueueResponse>('/tasks/fetch', {
      method: 'POST',
      body: JSON.stringify({ dedupe: true })
    }),
  runAnalyzeTask: () => request<ClassificationJobResponse>('/tasks/analyze', { method: 'POST' }),
  getRoutingEmbeddingCacheSummary: () => request<RoutingEmbeddingCacheSummary | null>('/tasks/embedding-cache'),
  listRoutingTags: () => request<RoutingTagListResponse>('/tags/routing'),
  refreshRoutingEmbeddingCache: (payload = {}) =>
    request<JobEnqueueResponse>('/tasks/embedding-cache/refresh', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  refreshRoutingEmbeddingCacheTag: (tag) =>
    request<JobEnqueueResponse>('/tasks/embedding-cache/refresh-tag', {
      method: 'POST',
      body: JSON.stringify({ tag })
    }),
  runReportTask: (payload) =>
    request<JobEnqueueResponse>('/tasks/report', {
      method: 'POST',
      body: JSON.stringify({
        notify: payload.notify,
        ...(payload.profileId ? { profileId: payload.profileId } : {}),
        ...(payload.windowEnd ? { windowEnd: payload.windowEnd } : {}),
        dedupe: true
      })
    }),
  getNotificationConfig: () => request<NotificationConfig>('/config/notification'),
  updateNotificationConfig: (payload) =>
    request<NotificationConfig>('/config/notification', { method: 'PUT', body: JSON.stringify(payload) }),
  sendTelegramTest: (payload = {}) =>
    request<TelegramTestResult>('/dev/notifications/test', { method: 'POST', body: JSON.stringify(payload) }),
  sendHighScoreReport: (id) => request<HighScoreSendResult>(`/reports/${id}/send-high-score`, { method: 'POST' }),
  listTagOptions: (params = {}) => {
    const search = new URLSearchParams();
    if (typeof params.limit === 'number') {
      search.set('limit', String(params.limit));
    }
    const query = search.toString();
    const path = query ? `/tags?${query}` : '/tags';
    return request<TagOptionsResponse>(path);
  },
  getDefaultReportProfile: () => request<ReportProfile>('/report-profiles/default'),
  listReports: (params = {}) => {
    const search = new URLSearchParams();
    if (params.profileId) {
      search.set('profileId', params.profileId);
    }
    if (typeof params.limit === 'number') {
      search.set('limit', String(params.limit));
    }
    const query = search.toString();
    const path = query ? `/reports?${query}` : '/reports';
    return request<ReportSummary[]>(path);
  },
  getReport: (id) => request<ReportDetail>(`/reports/${id}`),
  sendReport: (id) => request(`/reports/${id}/send`, { method: 'POST' }),
  publishReport: (id) => request<ReportPublishResult>(`/reports/${id}/publish`, { method: 'POST' }),
  generateSocialDigest: (id, payload = {}) =>
    request<JobEnqueueResponse>(`/reports/${id}/social`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  listReportProfiles: () => request<ReportProfile[]>('/report-profiles'),
  createReportProfile: (payload) =>
    request<ReportProfile>('/report-profiles', { method: 'POST', body: JSON.stringify(payload) }),
  updateReportProfile: (id, payload) =>
    request<ReportProfile>(`/report-profiles/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteReportProfile: (id) => request<null>(`/report-profiles/${id}`, { method: 'DELETE' }).then(() => undefined),
  runReportProfile: (id, payload = {}) =>
    request<JobEnqueueResponse>(`/report-profiles/${id}/run`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  listTweets: (params = {}) => {
    const search = new URLSearchParams();
    if (typeof params.page === 'number') {
      search.set('page', String(params.page));
    }
    if (typeof params.pageSize === 'number') {
      search.set('pageSize', String(params.pageSize));
    }
    if (params.sort) {
      search.set('sort', params.sort);
    }
    if (params.routing) {
      search.set('routing', params.routing);
    }
    if (params.routingTag) {
      search.set('routingTag', params.routingTag);
    }
    if (typeof params.routingScoreMin === 'number') {
      search.set('routingScoreMin', String(params.routingScoreMin));
    }
    if (typeof params.routingScoreMax === 'number') {
      search.set('routingScoreMax', String(params.routingScoreMax));
    }
    if (params.subscriptionId) {
      search.set('subscriptionId', params.subscriptionId);
    }
    if (params.startTime) {
      search.set('startTime', params.startTime);
    }
    if (params.endTime) {
      search.set('endTime', params.endTime);
    }
    if (params.q) {
      search.set('q', params.q);
    }
    if (typeof params.importanceMin === 'number') {
      search.set('importanceMin', String(params.importanceMin));
    }
    if (typeof params.importanceMax === 'number') {
      search.set('importanceMax', String(params.importanceMax));
    }
    const query = search.toString();
    const path = query ? `/tweets?${query}` : '/tweets';
    return request<TweetListResponse>(path);
  },
  analyzeTweets: (tweetIds) =>
    request<{ processed: number; insights: number }>('/tweets/analyze', {
      method: 'POST',
      body: JSON.stringify({ tweetIds })
    }),
  getTweetStats: (params = {}) => {
    const search = new URLSearchParams();
    if (params.subscriptionId) {
      search.set('subscriptionId', params.subscriptionId);
    }
    if (params.startTime) {
      search.set('startTime', params.startTime);
    }
    if (params.endTime) {
      search.set('endTime', params.endTime);
    }
    if (typeof params.highScoreMinImportance === 'number') {
      search.set('highScoreMinImportance', String(params.highScoreMinImportance));
    }
    if (typeof params.tagLimit === 'number') {
      search.set('tagLimit', String(params.tagLimit));
    }
    if (typeof params.authorLimit === 'number') {
      search.set('authorLimit', String(params.authorLimit));
    }
    const query = search.toString();
    const path = query ? `/tweets/stats?${query}` : '/tweets/stats';
    return request<TweetStatsResponse>(path);
  },
  listJobs: (params = {}) => {
    const search = new URLSearchParams();
    if (params.type) {
      search.set('type', params.type);
    }
    if (params.status) {
      search.set('status', params.status);
    }
    if (typeof params.limit === 'number') {
      search.set('limit', String(params.limit));
    }
    const query = search.toString();
    const path = query ? `/tasks/jobs?${query}` : '/tasks/jobs';
    return request<BackgroundJobSummary[]>(path);
  },
  getJob: (id) => request<BackgroundJobSummary>(`/tasks/jobs/${id}`),
  deleteJob: (id) => request<null>(`/dev/jobs/${id}`, { method: 'DELETE' }).then(() => undefined)
};
