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

export function DashboardPage() {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportDetail | null>(null);
  const [notifyOnReport, setNotifyOnReport] = useState(true);
  const [statusMessage, setStatusMessage] = useState('');
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

  useEffect(() => {
    refreshReports();
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

  async function runTask(task: 'fetch' | 'analyze' | 'report') {
    setBusy(`task-${task}`);
    try {
      if (task === 'fetch') {
        const result = await api.runFetchTask();
        const completed = result.filter((item) => !item.skipped && !item.error);
        const skipped = result.filter((item) => item.skipped);
        const failed = result.filter((item) => item.error && !item.skipped);
        const inserted = completed.reduce((sum, item) => sum + item.inserted, 0);
        const parts = [`处理 ${completed.length} 个订阅`];
        if (inserted) {
          parts.push(`新增 ${inserted} 条推文`);
        }
        if (skipped.length) {
          parts.push(`跳过 ${skipped.length}`);
        }
        if (failed.length) {
          parts.push(`失败 ${failed.length}`);
        }
        setStatusMessage(`抓取完成：${parts.join('，')}`);
      } else if (task === 'analyze') {
        const result = await api.runAnalyzeTask();
        setStatusMessage(`AI 已处理 ${result.processed} 条推文`);
      } else {
        const report = await api.runReportTask(notifyOnReport);
        if ('message' in report) {
          setStatusMessage(report.message);
        } else {
          setStatusMessage('日报生成完成');
          await refreshReports();
          if (!notifyOnReport) {
            await loadReport(report.id);
          }
        }
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
          </div>
          <div className="task-card">
            <h3>2. AI 筛选</h3>
            <p>DeepSeek 打标签，过滤掉噪音，提炼重点。</p>
            <button onClick={() => runTask('analyze')} disabled={busy === 'task-analyze'}>
              {busy === 'task-analyze' ? '执行中...' : '执行'}
            </button>
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
