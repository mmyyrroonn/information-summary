import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { api } from '../api';
import type { ReportDetail, ReportSummary } from '../types';

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
  const [statusMessage, setStatusMessage] = useState('');
  const [statusLink, setStatusLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
      setStatusLink(null);
    }
  }

  async function loadReport(id: string) {
    try {
      const data = await api.getReport(id);
      setSelectedReport(data);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '读取日报失败');
      setStatusLink(null);
    }
  }

  async function handleSendReport(id: string) {
    setBusy(`send-${id}`);
    try {
      await api.sendReport(id);
      setStatusMessage('推送成功');
      setStatusLink(null);
      await refreshReports();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '推送失败');
      setStatusLink(null);
    } finally {
      setBusy(null);
    }
  }

  async function handlePublishReport(id: string) {
    setBusy(`publish-${id}`);
    try {
      const result = await api.publishReport(id);
      const link = result.url || result.indexUrl || null;
      setStatusMessage(link ? 'GitHub 发布成功' : 'GitHub 发布成功（未配置链接）');
      setStatusLink(link);
      await refreshReports();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'GitHub 发布失败');
      setStatusLink(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {statusMessage && (
        <p className="status">
          {statusMessage}
          {statusLink ? (
            <>
              {' '}
              <a href={statusLink} target="_blank" rel="noreferrer">
                打开
              </a>
            </>
          ) : null}
        </p>
      )}
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
                <div className="report-info">
                  <p className="title">{report.headline}</p>
                  <p className="meta">
                    {new Date(report.periodStart).toLocaleDateString()} - {new Date(report.periodEnd).toLocaleDateString()}
                  </p>
                  <div className="report-actions">
                    <button
                      className="ghost"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSendReport(report.id);
                      }}
                      disabled={busy === `send-${report.id}`}
                    >
                      推送TG
                    </button>
                    <button
                      className="ghost"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePublishReport(report.id);
                      }}
                      disabled={busy === `publish-${report.id}`}
                    >
                      推送 GitHub
                    </button>
                  </div>
                  <div className="report-status">
                    <span>Telegram: {report.deliveredAt ? '已推送' : '未推送'}</span>
                    <span>GitHub: {report.publishedAt ? '已发布' : '未发布'}</span>
                  </div>
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
