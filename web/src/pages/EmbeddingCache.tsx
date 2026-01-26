import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type {
  BackgroundJobSummary,
  RoutingEmbeddingCacheSummary,
  RoutingTagListResponse
} from '../types';

const JOB_POLL_INTERVAL_MS = 4000;

type RefreshDraft = {
  windowDays: string;
  samplePerTag: string;
};

type TagJobState = {
  job?: BackgroundJobSummary;
  message?: string | null;
  loading?: boolean;
};

function parseOptionalPositiveInt(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) return { value: undefined };
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { error: `${label}需要正整数` };
  }
  return { value: Math.floor(parsed) };
}

function formatJobStatus(job?: BackgroundJobSummary) {
  if (!job) return null;
  const status = job.status;
  const label =
    status === 'PENDING'
      ? '排队中'
      : status === 'RUNNING'
        ? '执行中'
        : status === 'COMPLETED'
          ? '已完成'
          : '失败';
  const detail = status === 'FAILED' && job.lastError ? `：${job.lastError}` : '';
  return { label: `${label}${detail}`, className: `job-status status-${status.toLowerCase()}` };
}

function formatMetric(value: number | null | undefined) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--';
  return value.toFixed(3);
}

export function EmbeddingCachePage() {
  const [cacheSummary, setCacheSummary] = useState<RoutingEmbeddingCacheSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryMessage, setSummaryMessage] = useState<string | null>(null);
  const [refreshDraft, setRefreshDraft] = useState<RefreshDraft>({ windowDays: '', samplePerTag: '' });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [refreshJob, setRefreshJob] = useState<BackgroundJobSummary | null>(null);
  const [routingTags, setRoutingTags] = useState<RoutingTagListResponse['tags']>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagJobs, setTagJobs] = useState<Record<string, TagJobState>>({});
  const pollersRef = useRef<Record<string, number>>({});
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    void loadSummary();
    void loadTags();
    return () => {
      aliveRef.current = false;
      Object.values(pollersRef.current).forEach((timer) => window.clearTimeout(timer));
      pollersRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSummary() {
    try {
      setSummaryMessage(null);
      setSummaryLoading(true);
      const summary = await api.getRoutingEmbeddingCacheSummary();
      setCacheSummary(summary);
    } catch (error) {
      setSummaryMessage(error instanceof Error ? error.message : '加载缓存信息失败');
    } finally {
      setSummaryLoading(false);
    }
  }

  async function loadTags() {
    try {
      setTagsLoading(true);
      const response = await api.listRoutingTags();
      setRoutingTags(response.tags);
    } catch (error) {
      setSummaryMessage(error instanceof Error ? error.message : '加载标签失败');
    } finally {
      setTagsLoading(false);
    }
  }

  function stopPolling(jobId: string) {
    const timer = pollersRef.current[jobId];
    if (timer) {
      window.clearTimeout(timer);
      delete pollersRef.current[jobId];
    }
  }

  function startPolling(
    jobId: string,
    onUpdate: (job: BackgroundJobSummary) => void,
    onDone: (job: BackgroundJobSummary) => void,
    onError: (message: string) => void
  ) {
    stopPolling(jobId);
    const poll = async () => {
      try {
        const job = await api.getJob(jobId);
        if (!aliveRef.current) return;
        onUpdate(job);
        if (job.status === 'COMPLETED' || job.status === 'FAILED') {
          stopPolling(jobId);
          onDone(job);
          return;
        }
        pollersRef.current[jobId] = window.setTimeout(poll, JOB_POLL_INTERVAL_MS);
      } catch (error) {
        stopPolling(jobId);
        if (!aliveRef.current) return;
        onError(error instanceof Error ? error.message : '任务状态查询失败');
      }
    };
    void poll();
  }

  async function handleGlobalRefresh() {
    setRefreshMessage(null);
    const windowDays = parseOptionalPositiveInt(refreshDraft.windowDays, '样本窗口');
    if (windowDays.error) {
      setRefreshMessage(windowDays.error);
      return;
    }
    const samplePerTag = parseOptionalPositiveInt(refreshDraft.samplePerTag, '每类样本数');
    if (samplePerTag.error) {
      setRefreshMessage(samplePerTag.error);
      return;
    }

    const payload: { windowDays?: number; samplePerTag?: number } = {};
    if (typeof windowDays.value === 'number') {
      payload.windowDays = windowDays.value;
    }
    if (typeof samplePerTag.value === 'number') {
      payload.samplePerTag = samplePerTag.value;
    }

    setRefreshing(true);
    try {
      const response = await api.refreshRoutingEmbeddingCache(payload);
      setRefreshJob(response.job);
      setRefreshMessage(response.message ?? (response.created ? '已加入队列' : '刷新任务已存在'));
      startPolling(
        response.job.id,
        (job) => setRefreshJob(job),
        (job) => {
          if (job.status === 'COMPLETED') {
            void loadSummary();
          }
        },
        (message) => setRefreshMessage(message)
      );
    } catch (error) {
      setRefreshMessage(error instanceof Error ? error.message : '刷新失败');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleTagRefresh(tag: string) {
    setTagJobs((prev) => ({
      ...prev,
      [tag]: { ...prev[tag], loading: true, message: undefined }
    }));
    try {
      const response = await api.refreshRoutingEmbeddingCacheTag(tag);
      setTagJobs((prev) => ({
        ...prev,
        [tag]: {
          ...prev[tag],
          loading: false,
          job: response.job,
          message: response.message ?? (response.created ? '已加入队列' : '刷新任务已存在')
        }
      }));
      startPolling(
        response.job.id,
        (job) =>
          setTagJobs((prev) => ({
            ...prev,
            [tag]: { ...prev[tag], job }
          })),
        (job) => {
          if (job.status === 'COMPLETED') {
            void loadSummary();
          }
        },
        (message) =>
          setTagJobs((prev) => ({
            ...prev,
            [tag]: { ...prev[tag], message }
          }))
      );
    } catch (error) {
      setTagJobs((prev) => ({
        ...prev,
        [tag]: {
          ...prev[tag],
          loading: false,
          message: error instanceof Error ? error.message : '刷新失败'
        }
      }));
    }
  }

  const summaryStatus = formatJobStatus(refreshJob ?? undefined);

  return (
    <section>
      <div className="section-head">
        <h2>Embedding 路由缓存</h2>
        <button type="button" onClick={loadSummary} disabled={summaryLoading}>
          {summaryLoading ? '刷新中...' : '刷新概览'}
        </button>
      </div>
      {summaryMessage && <p className="status">{summaryMessage}</p>}
      <div className="cache-grid">
        <div className="cache-card">
          <h3>缓存概览</h3>
          {summaryLoading ? (
            <p className="hint">加载中...</p>
          ) : cacheSummary ? (
            <div className="cache-metrics">
              <div>
                <span>更新时间</span>
                <strong>{new Date(cacheSummary.updatedAt).toLocaleString()}</strong>
              </div>
              <div>
                <span>窗口</span>
                <strong>{cacheSummary.windowDays} 天</strong>
              </div>
              <div>
                <span>每类样本</span>
                <strong>{cacheSummary.samplePerTag}</strong>
              </div>
              <div>
                <span>总样本</span>
                <strong>{cacheSummary.totalSamples}</strong>
              </div>
              <div>
                <span>负样本</span>
                <strong>{cacheSummary.negativeSampleCount}</strong>
              </div>
              <div>
                <span>模型</span>
                <strong>
                  {cacheSummary.model} · {cacheSummary.dimensions}D
                </strong>
              </div>
            </div>
          ) : (
            <p className="hint">暂无缓存数据。</p>
          )}
        </div>
        <div className="cache-card">
          <h3>全量刷新</h3>
          {refreshMessage && <p className="status">{refreshMessage}</p>}
          <p className="hint">留空使用默认：窗口 120 天 / 每类 200</p>
          <div className="config-grid">
            <label>
              样本窗口（天）
              <input
                type="number"
                min={1}
                placeholder="默认 120"
                value={refreshDraft.windowDays}
                onChange={(e) => setRefreshDraft((prev) => ({ ...prev, windowDays: e.target.value }))}
              />
            </label>
            <label>
              每类样本数
              <input
                type="number"
                min={1}
                placeholder="默认 200"
                value={refreshDraft.samplePerTag}
                onChange={(e) => setRefreshDraft((prev) => ({ ...prev, samplePerTag: e.target.value }))}
              />
            </label>
            <button type="button" onClick={handleGlobalRefresh} disabled={refreshing}>
              {refreshing ? '提交中...' : '刷新缓存'}
            </button>
          </div>
          {summaryStatus && <p className={summaryStatus.className}>{summaryStatus.label}</p>}
        </div>
      </div>

      <div className="dev-divider" />

      <div className="section-head">
        <h2>按类别刷新</h2>
      </div>
      {tagsLoading ? <p className="hint">标签加载中...</p> : null}
      {!tagsLoading && routingTags.length === 0 ? <p className="hint">暂无可刷新标签。</p> : null}
      <div className="tag-refresh-grid">
        {routingTags.map((tag) => {
          const state = tagJobs[tag.tag];
          const status = formatJobStatus(state?.job);
          const metric = cacheSummary?.tagMetrics?.[tag.tag];
          const count = metric?.sampleCount ?? cacheSummary?.tagSampleCounts?.[tag.tag] ?? 0;
          const meanSim = formatMetric(metric?.meanSim);
          const negativeDistance = formatMetric(metric?.negativeDistance);
          return (
            <div className="tag-refresh-card" key={tag.tag}>
              <div className="tag-refresh-meta">
                <span>{tag.label}</span>
                <span className="tag-refresh-code">{tag.tag}</span>
              </div>
              <p className="hint">缓存样本：{count}</p>
              <p className="hint">类内均值相似度：{meanSim}</p>
              <p className="hint">距负样本中心：{negativeDistance}</p>
              <button type="button" onClick={() => handleTagRefresh(tag.tag)} disabled={state?.loading}>
                {state?.loading ? '提交中...' : '刷新该类'}
              </button>
              {state?.message && <p className="status">{state.message}</p>}
              {status && <p className={status.className}>{status.label}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
