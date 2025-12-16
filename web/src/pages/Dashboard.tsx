import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { api } from '../api';
import type { BackgroundJobSummary, JobEnqueueResponse, ReportDetail, ReportSummary } from '../types';

marked.setOptions({
  gfm: true,
  breaks: true
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer noopener');
  }
});

type TaskType = 'fetch' | 'analyze' | 'report';

interface TaskJobState {
  job?: BackgroundJobSummary;
  skipInfo?: {
    reason?: string;
    pending: number;
    threshold?: number;
  };
}

const POLL_INTERVAL_MS = 4000;

type ClusteredReportOutline = {
  mode: 'clustered';
  totalInsights: number;
  rawInsights?: number;
  triage?: {
    enabled: boolean;
    highKept: number;
    midCandidates: number;
    midKept: number;
  };
  totalClusters: number;
  shownClusters: number;
  sections: Array<{
    tag: string;
    title: string;
    clusters: Array<{
      id: string;
      size: number;
      peakImportance: number;
      tags: string[];
      representative: {
        tweetId: string;
        tweetUrl: string;
        summary: string;
        importance: number;
        verdict: string;
        suggestions?: string | null;
      };
      memberTweetIds: string[];
    }>;
  }>;
};

function asClusteredOutline(value: unknown): ClusteredReportOutline | null {
  if (!value || typeof value !== 'object') return null;
  const mode = (value as Record<string, unknown>).mode;
  if (mode !== 'clustered') return null;
  const sections = (value as Record<string, unknown>).sections;
  if (!Array.isArray(sections)) return null;
  return value as ClusteredReportOutline;
}

function tweetLink(id: string) {
  return `https://x.com/i/web/status/${id}`;
}

export function DashboardPage() {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportDetail | null>(null);
  const [notifyOnReport, setNotifyOnReport] = useState(true);
  const [statusMessage, setStatusMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [taskJobs, setTaskJobs] = useState<Record<TaskType, TaskJobState>>({
    fetch: {},
    analyze: {},
    report: {}
  });
  const pollers = useRef<Record<TaskType, number | null>>({
    fetch: null,
    analyze: null,
    report: null
  });
  const aliveRef = useRef(true);
  const reportHtml = useMemo(() => {
    if (!selectedReport?.content) {
      return '';
    }
    const withLinks = linkifyTweetIds(selectedReport.content);
    const parsed = marked.parse(withLinks);
    const rawHtml = typeof parsed === 'string' ? parsed : '';
    return DOMPurify.sanitize(rawHtml);
  }, [selectedReport?.content]);

  const clusteredOutline = useMemo(() => asClusteredOutline(selectedReport?.outline), [selectedReport?.outline]);

  useEffect(() => {
    refreshReports();
    hydrateActiveJobs();
    return () => {
      aliveRef.current = false;
      (['fetch', 'analyze', 'report'] as TaskType[]).forEach((task) => stopPolling(task));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshReports() {
    try {
      const reportsList = await api.listReports();
      setReports(reportsList);
      if (reportsList.length) {
        await loadReport(reportsList[0].id);
      } else {
        setSelectedReport(null);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载日报失败');
    }
  }

  async function loadReport(id: string) {
    try {
      const data = await api.getReport(id);
      setSelectedReport(data);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '读取日报失败');
    }
  }

  async function hydrateActiveJobs() {
    try {
      const jobs = await api.listJobs({ limit: 20 });
      jobs
        .filter((job) => job.status === 'PENDING' || job.status === 'RUNNING')
        .forEach((job) => {
          const task = mapJobType(job.type);
          if (!task) return;
          setTaskJobs((prev) => ({
            ...prev,
            [task]: { job }
          }));
          startJobPolling(task, job.id);
        });
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载任务状态失败');
    }
  }

  function mapJobType(type: string): TaskType | null {
    switch (type) {
      case 'fetch-subscriptions':
        return 'fetch';
      case 'classify-tweets':
        return 'analyze';
      case 'report-pipeline':
        return 'report';
      default:
        return null;
    }
  }

  function shortJobId(id: string) {
    return id.slice(0, 8);
  }

  function stopPolling(task: TaskType) {
    const timer = pollers.current[task];
    if (timer) {
      window.clearTimeout(timer);
      pollers.current[task] = null;
    }
  }

  function startJobPolling(task: TaskType, jobId: string) {
    stopPolling(task);
    const poll = async () => {
      try {
        const job = await api.getJob(jobId);
        if (!aliveRef.current) return;
        setTaskJobs((prev) => ({
          ...prev,
          [task]: { job }
        }));
        if (job.status === 'COMPLETED') {
          stopPolling(task);
          handleJobCompletion(task);
          return;
        }
        if (job.status === 'FAILED') {
          stopPolling(task);
          setStatusMessage(job.lastError ? `任务失败：${job.lastError}` : '任务失败');
          return;
        }
        pollers.current[task] = window.setTimeout(poll, POLL_INTERVAL_MS);
      } catch (error) {
        stopPolling(task);
        if (!aliveRef.current) {
          return;
        }
        setStatusMessage(error instanceof Error ? error.message : '任务状态查询失败');
      }
    };
    void poll();
  }

  function handleJobCompletion(task: TaskType) {
    if (!aliveRef.current) return;
    if (task === 'fetch') {
      setStatusMessage('抓取任务完成');
    } else if (task === 'analyze') {
      setStatusMessage('AI 筛选任务完成');
    } else {
      setStatusMessage('日报生成完成');
      void refreshReports();
    }
  }

  function handleJobEnqueue(task: TaskType, result: JobEnqueueResponse, label: string) {
    setTaskJobs((prev) => ({
      ...prev,
      [task]: { job: result.job }
    }));
    const message =
      result.message ??
      (result.created
        ? `${label}已加入队列（${shortJobId(result.job.id)}）`
        : `${label}已在执行（${shortJobId(result.job.id)}）`);
    setStatusMessage(message);
    startJobPolling(task, result.job.id);
  }

  function renderJobStatus(task: TaskType) {
    const state = taskJobs[task];
    if (!state) {
      return null;
    }
    if (state.skipInfo && !state.job) {
      const { pending, threshold, reason } = state.skipInfo;
      const text =
        reason === 'below-threshold'
          ? `待处理推文 ${pending}${threshold ? `/${threshold}` : ''}，尚未达到阈值`
          : '当前没有待处理推文';
      return <p className="job-status muted">{text}</p>;
    }
    const job = state.job;
    if (!job) {
      return null;
    }
    const labelMap = {
      PENDING: '排队中',
      RUNNING: '执行中',
      COMPLETED: '已完成',
      FAILED: '失败'
    } as const;
    const base = labelMap[job.status] ?? job.status;
    const timestamp =
      job.status === 'RUNNING' && job.lockedAt
        ? new Date(job.lockedAt).toLocaleTimeString()
        : job.status === 'COMPLETED' && job.completedAt
          ? new Date(job.completedAt).toLocaleTimeString()
          : null;
    const extra =
      job.status === 'FAILED' && job.lastError
        ? `：${job.lastError}`
        : job.status === 'COMPLETED'
          ? ' ✅'
          : '';
    return (
      <p className={`job-status status-${job.status.toLowerCase()}`}>
        {`任务 ${shortJobId(job.id)} ${base}${timestamp ? `（${timestamp}）` : ''}${extra}`}
      </p>
    );
  }

  async function runTask(task: TaskType) {
    setBusy(`task-${task}`);
    try {
      if (task === 'fetch') {
        const result = await api.runFetchTask();
        handleJobEnqueue('fetch', result, '抓取任务');
      } else if (task === 'analyze') {
        const result = await api.runAnalyzeTask();
        if (result.skipped) {
          const message =
            result.reason === 'below-threshold'
              ? `待处理推文 ${result.pending}${result.threshold ? `/${result.threshold}` : ''}，暂不触发`
              : '当前没有待处理推文';
          setStatusMessage(message);
          setTaskJobs((prev) => ({
            ...prev,
            analyze: {
              skipInfo: {
                reason: result.reason,
                pending: result.pending,
                threshold: result.threshold
              }
            }
          }));
          return;
        }
        if (result.job) {
          handleJobEnqueue(
            'analyze',
            {
              job: result.job,
              created: result.created ?? false
            },
            'AI 筛选任务'
          );
        }
      } else {
        const result = await api.runReportTask(notifyOnReport);
        handleJobEnqueue('report', result, notifyOnReport ? '推送日报任务' : '日报生成任务');
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '任务执行失败');
    } finally {
      setBusy(null);
    }
  }

  async function handleSendReport(id: string) {
    setBusy(`send-${id}`);
    try {
      await api.sendReport(id);
      setStatusMessage('推送成功');
      await refreshReports();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '推送失败');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {statusMessage && <p className="status">{statusMessage}</p>}
      <section>
        <div className="section-head">
          <h2>处理工作流</h2>
        </div>
        <div className="task-grid">
          <div className="task-card">
            <h3>1. 抓取推文</h3>
            <p>遍历全部订阅，获取当天未处理推文。</p>
            <button onClick={() => runTask('fetch')} disabled={busy === 'task-fetch'}>
              {busy === 'task-fetch' ? '执行中...' : '执行'}
            </button>
            {renderJobStatus('fetch')}
          </div>
          <div className="task-card">
            <h3>2. AI 筛选</h3>
            <p>DeepSeek 打标签，过滤掉噪音，提炼重点。</p>
            <button onClick={() => runTask('analyze')} disabled={busy === 'task-analyze'}>
              {busy === 'task-analyze' ? '执行中...' : '执行'}
            </button>
            {renderJobStatus('analyze')}
          </div>
          <div className="task-card">
            <h3>3. 汇总 & 推送</h3>
            <label className="notify-toggle">
              <input type="checkbox" checked={notifyOnReport} onChange={(e) => setNotifyOnReport(e.target.checked)} />
              生成后自动推送到 Telegram
            </label>
            <button onClick={() => runTask('report')} disabled={busy === 'task-report'}>
              {busy === 'task-report' ? '执行中...' : '生成日报'}
            </button>
            {renderJobStatus('report')}
          </div>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>日报记录</h2>
          <button onClick={refreshReports}>刷新列表</button>
        </div>
        <div className="reports-panel">
          <div className="reports-list">
            {reports.length === 0 && <p className="empty">暂无日报</p>}
            {reports.map((report) => (
              <div
                key={report.id}
                className={`report-row ${selectedReport?.id === report.id ? 'active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => loadReport(report.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadReport(report.id);
                }}
              >
                <div>
                  <p className="title">{report.headline}</p>
                  <p className="meta">
                    {new Date(report.periodStart).toLocaleDateString()} - {new Date(report.periodEnd).toLocaleDateString()}
                  </p>
                </div>
                <div className="row-actions">
                  <span>{report.deliveredAt ? '已推送' : '未推送'}</span>
                  <button
                    className="ghost"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSendReport(report.id);
                    }}
                    disabled={busy === `send-${report.id}`}
                  >
                    推送
                  </button>
                </div>
              </div>
            ))}
          </div>
          <article className="report-view">
            {selectedReport ? (
              <>
                <h3>{selectedReport.headline}</h3>
                {reportHtml ? (
                  <div className="markdown-body" dangerouslySetInnerHTML={{ __html: reportHtml }} />
                ) : (
                  <p className="empty">报告内容为空</p>
                )}
                {clusteredOutline ? (
                  <details className="cluster-debug">
                    <summary>
                      聚类明细（展示 {clusteredOutline.shownClusters} / 总计 {clusteredOutline.totalClusters}，候选{' '}
                      {clusteredOutline.totalInsights}
                      {clusteredOutline.triage?.enabled &&
                      typeof clusteredOutline.rawInsights === 'number' &&
                      clusteredOutline.rawInsights !== clusteredOutline.totalInsights
                        ? `；原始 ${clusteredOutline.rawInsights}，4-5⭐ ${clusteredOutline.triage.highKept}，2-3⭐ ${clusteredOutline.triage.midCandidates}→${clusteredOutline.triage.midKept}`
                        : ''}
                      ）
                    </summary>
                    <div className="cluster-debug-body">
                      {clusteredOutline.sections.map((section) => (
                        <details key={section.tag} className="cluster-tag">
                          <summary>
                            {section.title}（{section.clusters.length}）
                          </summary>
                          <div className="cluster-tag-body">
                            {section.clusters.map((cluster) => (
                              <details key={cluster.id} className="cluster-item">
                                <summary>
                                  #{cluster.id}（{cluster.size}条 / 最高{cluster.peakImportance}⭐）：{cluster.representative.summary}
                                </summary>
                                <div className="cluster-item-body">
                                  <p className="muted">
                                    代表推文：{' '}
                                    <a href={cluster.representative.tweetUrl || tweetLink(cluster.representative.tweetId)} target="_blank" rel="noreferrer">
                                      {cluster.representative.tweetId}
                                    </a>
                                  </p>
                                  <div className="cluster-member-list">
                                    {cluster.memberTweetIds.map((tweetId) => (
                                      <a key={tweetId} href={tweetLink(tweetId)} target="_blank" rel="noreferrer" className="cluster-member">
                                        {tweetId}
                                      </a>
                                    ))}
                                  </div>
                                </div>
                              </details>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="empty">选择左侧的日报查看详情</p>
            )}
          </article>
        </div>
      </section>
    </>
  );
}

function linkifyTweetIds(markdown: string) {
  const wrap = (id: string) => `[${id}](https://x.com/i/web/status/${id})`;
  return markdown
    .replace(/(\()(\d{10,})(\))/g, (_, open: string, id: string, close: string) => `${open}${wrap(id)}${close}`)
    .replace(/(（来源[:：]?\s*)(\d{10,})(）)/g, (_, prefix: string, id: string, suffix: string) => `${prefix}${wrap(id)}${suffix}`)
    .replace(/(^-\s+)(\d{10,})(\s*)$/gm, (_, bullet: string, id: string, trailing: string) => `${bullet}${wrap(id)}${trailing}`)
    .replace(/(tweet\s*id[:：]\s*)(\d{10,})/gi, (_, prefix: string, id: string) => `${prefix}${wrap(id)}`);
}
