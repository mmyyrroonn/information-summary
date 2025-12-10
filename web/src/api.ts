import type {
  Subscription,
  NotificationConfig,
  ReportDetail,
  ReportSummary,
  FetchResult,
  TweetListResponse,
  SubscriptionImportResult,
  BackgroundJobSummary,
  BackgroundJobStatus,
  JobEnqueueResponse,
  ClassificationJobResponse
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
  fetchSubscription: (id: string) => Promise<FetchResult>;
  importListMembers: (payload: { listId: string; cursor?: string }) => Promise<SubscriptionImportResult>;
  importFollowingUsers: (payload: { screenName?: string; userId?: string; cursor?: string }) => Promise<SubscriptionImportResult>;
  runFetchTask: () => Promise<JobEnqueueResponse>;
  runAnalyzeTask: () => Promise<ClassificationJobResponse>;
  runReportTask: (notify: boolean) => Promise<JobEnqueueResponse>;
  getNotificationConfig: () => Promise<NotificationConfig>;
  updateNotificationConfig: (payload: NotificationConfig) => Promise<NotificationConfig>;
  listReports: () => Promise<ReportSummary[]>;
  getReport: (id: string) => Promise<ReportDetail>;
  sendReport: (id: string) => Promise<unknown>;
  listTweets: (params?: {
    page?: number;
    pageSize?: number;
    sort?: 'newest' | 'oldest' | 'priority';
    subscriptionId?: string;
    startTime?: string;
    endTime?: string;
  }) => Promise<TweetListResponse>;
  analyzeTweets: (tweetIds: string[]) => Promise<{ processed: number; insights: number }>;
  listJobs: (params?: { type?: string; status?: BackgroundJobStatus; limit?: number }) => Promise<BackgroundJobSummary[]>;
  getJob: (id: string) => Promise<BackgroundJobSummary>;
  deleteJob: (id: string) => Promise<void>;
}

export const api: ApiClient = {
  listSubscriptions: () => request<Subscription[]>('/subscriptions'),
  createSubscription: (payload) => request<Subscription>('/subscriptions', { method: 'POST', body: JSON.stringify(payload) }),
  deleteSubscription: (id) => request<null>(`/subscriptions/${id}`, { method: 'DELETE' }).then(() => undefined),
  fetchSubscription: (id) => request<FetchResult>(`/subscriptions/${id}/fetch`, { method: 'POST' }),
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
  runReportTask: (notify: boolean) =>
    request<JobEnqueueResponse>('/tasks/report', {
      method: 'POST',
      body: JSON.stringify({ notify, dedupe: true })
    }),
  getNotificationConfig: () => request<NotificationConfig>('/config/notification'),
  updateNotificationConfig: (payload) =>
    request<NotificationConfig>('/config/notification', { method: 'PUT', body: JSON.stringify(payload) }),
  listReports: () => request<ReportSummary[]>('/reports'),
  getReport: (id) => request<ReportDetail>(`/reports/${id}`),
  sendReport: (id) => request(`/reports/${id}/send`, { method: 'POST' }),
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
    if (params.subscriptionId) {
      search.set('subscriptionId', params.subscriptionId);
    }
    if (params.startTime) {
      search.set('startTime', params.startTime);
    }
    if (params.endTime) {
      search.set('endTime', params.endTime);
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
