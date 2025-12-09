import type { Subscription, NotificationConfig, ReportDetail, ReportSummary, FetchResult } from './types';

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
  runFetchTask: () => Promise<FetchResult[]>;
  runAnalyzeTask: () => Promise<{ processed: number; insights: number }>;
  runReportTask: (notify: boolean) => Promise<ReportSummary | { message: string }>;
  getNotificationConfig: () => Promise<NotificationConfig>;
  updateNotificationConfig: (payload: NotificationConfig) => Promise<NotificationConfig>;
  listReports: () => Promise<ReportSummary[]>;
  getReport: (id: string) => Promise<ReportDetail>;
  sendReport: (id: string) => Promise<unknown>;
}

export const api: ApiClient = {
  listSubscriptions: () => request<Subscription[]>('/subscriptions'),
  createSubscription: (payload) => request<Subscription>('/subscriptions', { method: 'POST', body: JSON.stringify(payload) }),
  deleteSubscription: (id) => request<null>(`/subscriptions/${id}`, { method: 'DELETE' }).then(() => undefined),
  fetchSubscription: (id) => request<FetchResult>(`/subscriptions/${id}/fetch`, { method: 'POST' }),
  runFetchTask: () => request<FetchResult[]>('/tasks/fetch', { method: 'POST' }),
  runAnalyzeTask: () => request<{ processed: number; insights: number }>('/tasks/analyze', { method: 'POST' }),
  runReportTask: (notify: boolean) =>
    request<ReportSummary | { message: string }>('/tasks/report', {
      method: 'POST',
      body: JSON.stringify({ notify })
    }),
  getNotificationConfig: () => request<NotificationConfig>('/config/notification'),
  updateNotificationConfig: (payload) =>
    request<NotificationConfig>('/config/notification', { method: 'PUT', body: JSON.stringify(payload) }),
  listReports: () => request<ReportSummary[]>('/reports'),
  getReport: (id) => request<ReportDetail>(`/reports/${id}`),
  sendReport: (id) => request(`/reports/${id}/send`, { method: 'POST' })
};
