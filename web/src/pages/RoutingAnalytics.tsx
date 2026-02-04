import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Subscription, TweetRoutingStatsResponse } from '../types';

function toIso(value: string) {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function formatCount(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return Math.round(value).toLocaleString('en-US');
}

function formatPercent(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return `${(value * 100).toFixed(digits)}%`;
}

export function RoutingAnalyticsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [stats, setStats] = useState<TweetRoutingStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [subscriptionId, setSubscriptionId] = useState<string | undefined>(undefined);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  useEffect(() => {
    loadSubscriptions();
  }, []);

  async function loadSubscriptions() {
    try {
      const subs = await api.listSubscriptions();
      setSubscriptions(subs);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载订阅失败');
    }
  }

  async function loadStats() {
    setLoading(true);
    try {
      const data = await api.getTweetRoutingStats({
        subscriptionId,
        startTime: toIso(startTime),
        endTime: toIso(endTime)
      });
      setStats(data);
      setStatusMessage('');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载统计失败');
    } finally {
      setLoading(false);
    }
  }

  const totals = stats?.totals;
  const totalTweets = totals?.totalTweets ?? null;
  const embeddingHigh = totals?.embeddingHigh ?? null;
  const embeddingLow = totals?.embeddingLow ?? null;
  const llmTotal = totals?.llmTotal ?? null;
  const llmCompleted = totals?.llmCompleted ?? null;
  const llmQueued = totals?.llmQueued ?? null;
  const llmRouted = totals?.llmRouted ?? null;
  const ignoredOther = totals?.ignoredOther ?? null;
  const pending = totals?.pending ?? null;

  const embeddingHighRatio = useMemo(() => {
    if (totalTweets === null) return null;
    return totalTweets ? (embeddingHigh ?? 0) / totalTweets : 0;
  }, [embeddingHigh, totalTweets]);

  const embeddingLowRatio = useMemo(() => {
    if (totalTweets === null) return null;
    return totalTweets ? (embeddingLow ?? 0) / totalTweets : 0;
  }, [embeddingLow, totalTweets]);

  const llmRatio = useMemo(() => {
    if (totalTweets === null) return null;
    return totalTweets ? (llmTotal ?? 0) / totalTweets : 0;
  }, [llmTotal, totalTweets]);

  const hasTimeFilter = Boolean(startTime || endTime);

  function clearTimeRange() {
    if (!hasTimeFilter) return;
    setStartTime('');
    setEndTime('');
  }

  return (
    <>
      {statusMessage && <p className="status">{statusMessage}</p>}
      <div className="analytics-page">
        <section className="analytics-hero">
          <div className="analytics-hero-main">
            <div>
              <p className="eyebrow">路由分流</p>
              <h2>Embedding 路由分析</h2>
              <p className="hint">查看 embedding 直接判定与 LLM 进入比例，定位分流策略效果。</p>
            </div>
            <div className="analytics-summary">
              <div className="summary-item">
                <span>样本量</span>
                <strong className="analytics-mono">{formatCount(totalTweets)}</strong>
                <p className="hint">用于分流统计</p>
              </div>
              <div className="summary-item">
                <span>Embedding 高分</span>
                <strong className="analytics-mono">{formatCount(embeddingHigh)}</strong>
                <p className="hint">占比 {formatPercent(embeddingHighRatio, 1)}</p>
              </div>
              <div className="summary-item">
                <span>Embedding 低分</span>
                <strong className="analytics-mono">{formatCount(embeddingLow)}</strong>
                <p className="hint">占比 {formatPercent(embeddingLowRatio, 1)}</p>
              </div>
              <div className="summary-item">
                <span>进入 LLM</span>
                <strong className="analytics-mono">{formatCount(llmTotal)}</strong>
                <p className="hint">占比 {formatPercent(llmRatio, 1)}</p>
              </div>
            </div>
          </div>

          <div className="analytics-filters">
            <label>
              <span>订阅账号</span>
              <select
                value={subscriptionId ?? ''}
                onChange={(e) => setSubscriptionId(e.target.value || undefined)}
              >
                <option value="">全部账号</option>
                {subscriptions.map((sub) => (
                  <option key={sub.id} value={sub.id}>
                    {sub.displayName ? `${sub.displayName} (@${sub.screenName})` : `@${sub.screenName}`}
                    {sub.status === 'UNSUBSCRIBED' ? '（不再订阅）' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>时间范围</span>
              <div className="analytics-range">
                <input
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
                <span className="analytics-range-sep">至</span>
                <input
                  type="datetime-local"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
                <button type="button" className="ghost" onClick={clearTimeRange} disabled={!hasTimeFilter}>
                  清除
                </button>
              </div>
            </label>

            <div className="analytics-actions">
              <button onClick={loadStats} disabled={loading}>
                {loading ? '加载中...' : '加载统计'}
              </button>
            </div>
          </div>
        </section>

        <section className="analytics-panel">
          <div className="section-head">
            <div>
              <h3>分流明细</h3>
              <p className="hint">embedding 直接判定与 LLM 分流的数量分布。</p>
            </div>
          </div>
          <table className="analytics-table">
            <thead>
              <tr>
                <th>类别</th>
                <th>数量</th>
                <th>占比</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Embedding 高分</td>
                <td className="analytics-mono">{formatCount(embeddingHigh)}</td>
                <td className="analytics-mono">{formatPercent(embeddingHighRatio, 1)}</td>
              </tr>
              <tr>
                <td>Embedding 低分</td>
                <td className="analytics-mono">{formatCount(embeddingLow)}</td>
                <td className="analytics-mono">{formatPercent(embeddingLowRatio, 1)}</td>
              </tr>
              <tr>
                <td>进入 LLM</td>
                <td className="analytics-mono">{formatCount(llmTotal)}</td>
                <td className="analytics-mono">{formatPercent(llmRatio, 1)}</td>
              </tr>
              <tr>
                <td>其他忽略</td>
                <td className="analytics-mono">{formatCount(ignoredOther)}</td>
                <td className="analytics-mono">
                  {totalTweets === null ? '—' : formatPercent(totalTweets ? (ignoredOther ?? 0) / totalTweets : 0, 1)}
                </td>
              </tr>
              <tr>
                <td>待路由</td>
                <td className="analytics-mono">{formatCount(pending)}</td>
                <td className="analytics-mono">
                  {totalTweets === null ? '—' : formatPercent(totalTweets ? (pending ?? 0) / totalTweets : 0, 1)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="analytics-panel">
          <div className="section-head">
            <div>
              <h3>LLM 进度</h3>
              <p className="hint">进入 LLM 的分阶段状态。</p>
            </div>
          </div>
          <table className="analytics-table">
            <thead>
              <tr>
                <th>阶段</th>
                <th>数量</th>
                <th>占 LLM 比例</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>待触发 (ROUTED)</td>
                <td className="analytics-mono">{formatCount(llmRouted)}</td>
                <td className="analytics-mono">
                  {llmTotal === null ? '—' : formatPercent(llmTotal ? (llmRouted ?? 0) / llmTotal : 0, 1)}
                </td>
              </tr>
              <tr>
                <td>排队中 (LLM_QUEUED)</td>
                <td className="analytics-mono">{formatCount(llmQueued)}</td>
                <td className="analytics-mono">
                  {llmTotal === null ? '—' : formatPercent(llmTotal ? (llmQueued ?? 0) / llmTotal : 0, 1)}
                </td>
              </tr>
              <tr>
                <td>已完成 (COMPLETED)</td>
                <td className="analytics-mono">{formatCount(llmCompleted)}</td>
                <td className="analytics-mono">
                  {llmTotal === null ? '—' : formatPercent(llmTotal ? (llmCompleted ?? 0) / llmTotal : 0, 1)}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
