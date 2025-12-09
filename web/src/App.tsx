import { FormEvent, useEffect, useState } from 'react';
import { api } from './api';
import type { ReportDetail, ReportSummary, Subscription } from './types';
import './App.css';

function App() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportDetail | null>(null);
  const [form, setForm] = useState({ screenName: '', displayName: '' });
  const [statusMessage, setStatusMessage] = useState('');
  const [notifyOnReport, setNotifyOnReport] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    refreshAll();
  }, []);

  async function refreshAll() {
    setStatusMessage('加载数据中...');
    try {
      const [subs, reportsList] = await Promise.all([api.listSubscriptions(), api.listReports()]);
      setSubscriptions(subs);
      setReports(reportsList);
      if (reportsList.length && !selectedReport) {
        loadReport(reportsList[0].id);
      }
      setStatusMessage('');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载失败');
    }
  }

  async function handleAddSubscription(event: FormEvent) {
    event.preventDefault();
    if (!form.screenName.trim()) return;
    setBusy('add-sub');
    try {
      await api.createSubscription({ screenName: form.screenName, displayName: form.displayName || undefined });
      setForm({ screenName: '', displayName: '' });
      await refreshSubscriptions();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '添加失败');
    } finally {
      setBusy(null);
    }
  }

  async function refreshSubscriptions() {
    const subs = await api.listSubscriptions();
    setSubscriptions(subs);
  }

  async function handleDeleteSubscription(id: string) {
    if (!confirm('确定要删除这个订阅吗？')) return;
    setBusy(`delete-${id}`);
    try {
      await api.deleteSubscription(id);
      await refreshSubscriptions();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '删除失败');
    } finally {
      setBusy(null);
    }
  }

  async function handleFetchSubscription(id: string) {
    setBusy(`fetch-${id}`);
    try {
      const result = await api.fetchSubscription(id);
      setStatusMessage(`已抓取 ${result.inserted} 条推文`);
      await refreshSubscriptions();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '抓取失败');
    } finally {
      setBusy(null);
    }
  }

  async function runTask(task: 'fetch' | 'analyze' | 'report') {
    setBusy(`task-${task}`);
    try {
      if (task === 'fetch') {
        const result = await api.runFetchTask();
        setStatusMessage(`完成抓取：${result.length} 个订阅`);
        await refreshSubscriptions();
      } else if (task === 'analyze') {
        const result = await api.runAnalyzeTask();
        setStatusMessage(`AI 已处理 ${result.processed} 条推文`);
      } else {
        const report = await api.runReportTask(notifyOnReport);
        if ('message' in report) {
          setStatusMessage(report.message);
        } else {
          setStatusMessage('周报生成完成');
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

  async function refreshReports() {
    const reportsList = await api.listReports();
    setReports(reportsList);
  }

  async function loadReport(id: string) {
    try {
      const data = await api.getReport(id);
      setSelectedReport(data);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '读取周报失败');
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
    <div className="app-shell">
      <header>
        <div>
          <p className="eyebrow">自动信息雷达</p>
          <h1>Twitter 周报控制台</h1>
          <p className="hint">配置订阅、触发 AI 工作流、查看周报与 TG 推送状态。</p>
        </div>
        {statusMessage && <p className="status">{statusMessage}</p>}
      </header>

      <section>
        <div className="section-head">
          <h2>订阅管理</h2>
          <button onClick={() => runTask('fetch')} disabled={busy === 'task-fetch'}>
            {busy === 'task-fetch' ? '抓取中...' : '抓取全部'}
          </button>
        </div>
        <form className="subscription-form" onSubmit={handleAddSubscription}>
          <input
            placeholder="Twitter @账号"
            value={form.screenName}
            onChange={(e) => setForm((prev) => ({ ...prev, screenName: e.target.value }))}
          />
          <input
            placeholder="备注"
            value={form.displayName}
            onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
          />
          <button type="submit" disabled={busy === 'add-sub'}>
            {busy === 'add-sub' ? '添加中...' : '添加订阅'}
          </button>
        </form>
        <div className="list">
          {subscriptions.length === 0 && <p className="empty">暂无订阅</p>}
          {subscriptions.map((sub) => (
            <div key={sub.id} className="list-item">
              <div>
                <p className="title">@{sub.screenName}</p>
                {sub.displayName && <p className="subtitle">{sub.displayName}</p>}
                {sub.lastFetchedAt && <p className="meta">上次抓取：{new Date(sub.lastFetchedAt).toLocaleString()}</p>}
              </div>
              <div className="item-actions">
                <button onClick={() => handleFetchSubscription(sub.id)} disabled={busy === `fetch-${sub.id}`}>
                  {busy === `fetch-${sub.id}` ? '抓取中' : '抓取'}
                </button>
                <button onClick={() => handleDeleteSubscription(sub.id)} disabled={busy === `delete-${sub.id}`} className="danger">
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

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
              {busy === 'task-report' ? '执行中...' : '生成周报'}
            </button>
          </div>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>周报记录</h2>
          <button onClick={refreshReports}>刷新列表</button>
        </div>
        <div className="reports-panel">
          <div className="reports-list">
            {reports.length === 0 && <p className="empty">暂无周报</p>}
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
                <pre>{selectedReport.content}</pre>
              </>
            ) : (
              <p className="empty">选择左侧的周报查看详情</p>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}

export default App;
