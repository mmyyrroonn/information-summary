import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { Subscription, TweetStatsResponse } from '../types';

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

function formatNumber(value: number | null | undefined, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  if (Number.isInteger(value)) {
    return value.toString();
  }
  return value.toFixed(digits);
}

function formatPercent(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return `${(value * 100).toFixed(digits)}%`;
}

function formatCount(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '—';
  }
  return Math.round(value).toLocaleString('en-US');
}

function formatVerdict(value: string) {
  switch (value) {
    case 'actionable':
      return 'Actionable';
    case 'watch':
      return 'Watch';
    case 'ignore':
      return 'Ignore';
    default:
      return value || '未知';
  }
}

export function AnalyticsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [stats, setStats] = useState<TweetStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [subscriptionId, setSubscriptionId] = useState<string | undefined>(undefined);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [highScoreMinImportance, setHighScoreMinImportance] = useState(4);
  const [tagLimit, setTagLimit] = useState(12);

  useEffect(() => {
    loadSubscriptions();
  }, []);

  useEffect(() => {
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionId, startTime, endTime, highScoreMinImportance, tagLimit]);

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
      const data = await api.getTweetStats({
        subscriptionId,
        startTime: toIso(startTime),
        endTime: toIso(endTime),
        highScoreMinImportance,
        tagLimit
      });
      setStats(data);
      setStatusMessage('');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载统计失败');
    } finally {
      setLoading(false);
    }
  }

  const maxBucketCount = useMemo(() => {
    if (!stats?.lengthBuckets.length) return 1;
    return Math.max(...stats.lengthBuckets.map((bucket) => bucket.count), 1);
  }, [stats]);

  const viewBucketMax = useMemo(() => {
    if (!stats?.viewBuckets.length) return 1;
    return Math.max(...stats.viewBuckets.map((bucket) => bucket.count), 1);
  }, [stats]);

  const matrixMax = useMemo(() => {
    if (!stats?.scoreLengthMatrix.rows.length) return 1;
    return Math.max(
      ...stats.scoreLengthMatrix.rows.flatMap((row) => row.counts),
      1
    );
  }, [stats]);

  const viewMatrixMax = useMemo(() => {
    if (!stats?.scoreViewMatrix.rows.length) return 1;
    return Math.max(
      ...stats.scoreViewMatrix.rows.flatMap((row) => row.counts),
      1
    );
  }, [stats]);

  const highScore = stats?.highScoreProfile;
  const scoreCoverage = stats?.totals.totalTweets ? stats.totals.scoredTweets / stats.totals.totalTweets : null;
  const highScoreRatio =
    stats?.totals.scoredTweets && stats.totals.highScoreTweets
      ? stats.totals.highScoreTweets / stats.totals.scoredTweets
      : null;
  const viewCoverage = stats?.totals.totalTweets ? stats.totals.viewTweets / stats.totals.totalTweets : null;

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
              <p className="eyebrow">数据透视</p>
              <h2>推文效果实验室</h2>
              <p className="hint">聚焦长度、评分与标签，让 AI 评分的效果更可解释。</p>
            </div>
            <div className="analytics-summary">
              <div className="summary-item">
                <span>样本量</span>
                <strong className="analytics-mono">{stats?.totals.totalTweets ?? '—'}</strong>
                <p className="hint">评分覆盖 {formatPercent(scoreCoverage, 0)}</p>
              </div>
              <div className="summary-item">
                <span>高分占比</span>
                <strong className="analytics-mono">{formatPercent(highScoreRatio, 1)}</strong>
                <p className="hint">阈值 ≥ {highScoreMinImportance}</p>
              </div>
              <div className="summary-item">
                <span>长度/得分相关</span>
                <strong className="analytics-mono">{formatNumber(stats?.totals.lengthImportanceCorrelation, 2)}</strong>
                <p className="hint">皮尔逊相关</p>
              </div>
              <div className="summary-item">
                <span>平均浏览量</span>
                <strong className="analytics-mono">{formatCount(stats?.totals.avgViews)}</strong>
                <p className="hint">覆盖 {formatPercent(viewCoverage, 0)}</p>
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

            <label>
              <span>高分阈值</span>
              <select
                value={highScoreMinImportance}
                onChange={(e) => setHighScoreMinImportance(Number(e.target.value))}
              >
                {[3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    ≥ {value}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>标签展示</span>
              <select value={tagLimit} onChange={(e) => setTagLimit(Number(e.target.value))}>
                {[8, 12, 16, 20].map((value) => (
                  <option key={value} value={value}>
                    Top {value}
                  </option>
                ))}
              </select>
            </label>

            <div className="analytics-actions">
              <button onClick={loadStats} disabled={loading}>
                {loading ? '加载中...' : '刷新统计'}
              </button>
            </div>
          </div>
        </section>

        <section className="analytics-grid">
          <div className="analytics-card">
            <p className="analytics-label">已评分推文</p>
            <p className="analytics-value analytics-mono">{stats?.totals.scoredTweets ?? '—'}</p>
            <p className="analytics-meta">占比 {formatPercent(scoreCoverage, 1)}</p>
          </div>
          <div className="analytics-card">
            <p className="analytics-label">高分推文</p>
            <p className="analytics-value analytics-mono">{stats?.totals.highScoreTweets ?? '—'}</p>
            <p className="analytics-meta">阈值 ≥ {highScoreMinImportance}</p>
          </div>
          <div className="analytics-card">
            <p className="analytics-label">平均长度</p>
            <p className="analytics-value analytics-mono">{formatNumber(stats?.totals.avgLength, 0)}字</p>
            <p className="analytics-meta">P90 {formatNumber(stats?.totals.p90Length, 0)}字</p>
          </div>
          <div className="analytics-card">
            <p className="analytics-label">平均重要度</p>
            <p className="analytics-value analytics-mono">{formatNumber(stats?.totals.avgImportance, 2)}</p>
            <p className="analytics-meta">中位数长度 {formatNumber(stats?.totals.medianLength, 0)}字</p>
          </div>
          <div className="analytics-card">
            <p className="analytics-label">长度相关</p>
            <p className="analytics-value analytics-mono">{formatNumber(stats?.totals.lengthImportanceCorrelation, 2)}</p>
            <p className="analytics-meta">长度与得分的线性相关</p>
          </div>
          <div className="analytics-card">
            <p className="analytics-label">平均浏览量</p>
            <p className="analytics-value analytics-mono">{formatCount(stats?.totals.avgViews)}</p>
            <p className="analytics-meta">P90 {formatCount(stats?.totals.p90Views)}</p>
          </div>
          <div className="analytics-card highlight">
            <p className="analytics-label">高分特征</p>
            <p className="analytics-value analytics-mono">{formatNumber(highScore?.avgTagsPerTweet, 2)} 标签/条</p>
            <p className="analytics-meta">建议率 {formatPercent(highScore?.suggestionRate, 0)}</p>
          </div>
        </section>

        <section className="analytics-panel">
          <div className="section-head">
            <div>
              <h3>长度分布</h3>
              <p className="hint">按字数区间观察评分与占比。</p>
            </div>
          </div>
          <div className="analytics-bars">
            {stats?.lengthBuckets.map((bucket) => {
              const width = `${(bucket.count / maxBucketCount) * 100}%`;
              return (
                <div key={bucket.label} className="analytics-bar-row">
                  <div className="analytics-bar-label">{bucket.label}</div>
                  <div className="analytics-bar">
                    <span style={{ width }} />
                  </div>
                  <div className="analytics-bar-meta analytics-mono">
                    <span>{bucket.count}</span>
                    <span>{formatNumber(bucket.avgLength, 0)}字</span>
                    <span>{formatNumber(bucket.avgImportance, 2)}分</span>
                    <span>{formatCount(bucket.avgViews)}</span>
                  </div>
                </div>
              );
            })}
            {!stats && <p className="empty">暂无统计数据</p>}
          </div>
        </section>

        <section className="analytics-panel">
          <div className="section-head">
            <div>
              <h3>浏览量分布</h3>
              <p className="hint">按浏览量区间观察得分与占比。</p>
            </div>
          </div>
          <div className="analytics-bars">
            {stats?.viewBuckets.map((bucket) => {
              const width = `${(bucket.count / viewBucketMax) * 100}%`;
              return (
                <div key={bucket.label} className="analytics-bar-row">
                  <div className="analytics-bar-label">{bucket.label}</div>
                  <div className="analytics-bar">
                    <span style={{ width }} />
                  </div>
                  <div className="analytics-bar-meta analytics-mono">
                    <span>{bucket.count}</span>
                    <span>{formatCount(bucket.avgViews)}</span>
                    <span>{formatNumber(bucket.avgImportance, 2)}分</span>
                  </div>
                </div>
              );
            })}
            {!stats && <p className="empty">暂无统计数据</p>}
          </div>
        </section>

        <section className="analytics-panel">
          <div className="section-head">
            <div>
              <h3>得分 × 长度透视</h3>
              <p className="hint">不同重要度在各长度区间的分布。</p>
            </div>
          </div>
          <div className="matrix-scroll">
            <table className="analytics-table matrix-table">
              <thead>
                <tr>
                  <th>得分</th>
                  {stats?.scoreLengthMatrix.buckets.map((bucket) => (
                    <th key={bucket.label}>{bucket.label}</th>
                  ))}
                  <th>均长</th>
                  <th>均浏览</th>
                  <th>总量</th>
                </tr>
              </thead>
              <tbody>
                {stats?.scoreLengthMatrix.rows.map((row) => (
                  <tr key={row.importance}>
                    <td className="analytics-mono">{row.importance}</td>
                    {row.counts.map((count, idx) => {
                      const intensity = count / matrixMax;
                      const background = `rgba(59, 130, 246, ${0.08 + intensity * 0.62})`;
                      return (
                        <td key={`${row.importance}-${idx}`}>
                          <div className="matrix-cell" style={{ background }}>
                            <span className="analytics-mono">{count || '-'}</span>
                          </div>
                        </td>
                      );
                    })}
                    <td className="analytics-mono">{formatNumber(row.avgLength, 0)}</td>
                    <td className="analytics-mono">{formatCount(row.avgViews)}</td>
                    <td className="analytics-mono">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="analytics-panel">
          <div className="section-head">
            <div>
              <h3>得分 × 浏览量透视</h3>
              <p className="hint">不同重要度在浏览量区间的分布。</p>
            </div>
          </div>
          <div className="matrix-scroll">
            <table className="analytics-table matrix-table">
              <thead>
                <tr>
                  <th>得分</th>
                  {stats?.scoreViewMatrix.buckets.map((bucket) => (
                    <th key={bucket.label}>{bucket.label}</th>
                  ))}
                  <th>均浏览</th>
                  <th>总量</th>
                </tr>
              </thead>
              <tbody>
                {stats?.scoreViewMatrix.rows.map((row) => (
                  <tr key={row.importance}>
                    <td className="analytics-mono">{row.importance}</td>
                    {row.counts.map((count, idx) => {
                      const intensity = count / viewMatrixMax;
                      const background = `rgba(249, 115, 22, ${0.08 + intensity * 0.62})`;
                      return (
                        <td key={`${row.importance}-${idx}`}>
                          <div className="matrix-cell" style={{ background }}>
                            <span className="analytics-mono">{count || '-'}</span>
                          </div>
                        </td>
                      );
                    })}
                    <td className="analytics-mono">{formatCount(row.avgViews)}</td>
                    <td className="analytics-mono">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="analytics-panel">
          <div className="section-head">
            <div>
              <h3>类别对比</h3>
              <p className="hint">类别维度的长度与得分摘要。</p>
            </div>
          </div>
          <div className="analytics-split">
            <div className="analytics-subpanel">
              <h4>Verdict 维度</h4>
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>类别</th>
                    <th>数量</th>
                    <th>平均长度</th>
                    <th>平均得分</th>
                    <th>平均浏览</th>
                  </tr>
                </thead>
                <tbody>
                  {stats?.verdictStats.map((item) => (
                    <tr key={item.verdict}>
                      <td>{formatVerdict(item.verdict)}</td>
                      <td className="analytics-mono">{item.count}</td>
                      <td className="analytics-mono">{formatNumber(item.avgLength, 0)}字</td>
                      <td className="analytics-mono">{formatNumber(item.avgImportance, 2)}</td>
                      <td className="analytics-mono">{formatCount(item.avgViews)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="analytics-subpanel">
              <h4>标签维度 (Top)</h4>
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>标签</th>
                    <th>数量</th>
                    <th>平均长度</th>
                    <th>平均得分</th>
                    <th>平均浏览</th>
                    <th>高分率</th>
                  </tr>
                </thead>
                <tbody>
                  {stats?.tagStats.map((item) => (
                    <tr key={item.tag}>
                      <td>{item.tag}</td>
                      <td className="analytics-mono">{item.count}</td>
                      <td className="analytics-mono">{formatNumber(item.avgLength, 0)}字</td>
                      <td className="analytics-mono">{formatNumber(item.avgImportance, 2)}</td>
                      <td className="analytics-mono">{formatCount(item.avgViews)}</td>
                      <td className="analytics-mono">{formatPercent(item.highScoreRatio, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="analytics-panel">
          <div className="section-head">
            <div>
              <h3>高分画像</h3>
              <p className="hint">高分推文的标签、作者与语言特征。</p>
            </div>
          </div>
          <div className="analytics-profile-grid">
            <div className="analytics-card">
              <p className="analytics-label">高分均长</p>
              <p className="analytics-value analytics-mono">{formatNumber(highScore?.avgLength, 0)}字</p>
              <p className="analytics-meta">P90 {formatNumber(highScore?.p90Length, 0)}字</p>
            </div>
            <div className="analytics-card">
              <p className="analytics-label">高分均浏览</p>
              <p className="analytics-value analytics-mono">{formatCount(highScore?.avgViews)}</p>
              <p className="analytics-meta">P90 {formatCount(highScore?.p90Views)}</p>
            </div>
            <div className="analytics-card">
              <p className="analytics-label">高分标签密度</p>
              <p className="analytics-value analytics-mono">{formatNumber(highScore?.avgTagsPerTweet, 2)}</p>
              <p className="analytics-meta">每条平均标签</p>
            </div>
            <div className="analytics-card">
              <p className="analytics-label">建议覆盖</p>
              <p className="analytics-value analytics-mono">{formatPercent(highScore?.suggestionRate, 0)}</p>
              <p className="analytics-meta">具备可执行建议</p>
            </div>
            <div className="analytics-card">
              <p className="analytics-label">摘要覆盖</p>
              <p className="analytics-value analytics-mono">{formatPercent(highScore?.summaryRate, 0)}</p>
              <p className="analytics-meta">具备摘要内容</p>
            </div>
          </div>

          <div className="analytics-lists">
            <div className="analytics-list">
              <h4>高分标签</h4>
              {highScore?.tags.map((item) => (
                <div key={item.tag} className="analytics-list-row">
                  <span>{item.tag}</span>
                  <div className="analytics-list-bar">
                    <span style={{ width: `${item.share * 100}%` }} />
                  </div>
                  <span className="analytics-mono">{item.count}</span>
                </div>
              ))}
            </div>
            <div className="analytics-list">
              <h4>高分作者</h4>
              {highScore?.authors.map((item) => (
                <div key={item.author} className="analytics-list-row">
                  <span>{item.author}</span>
                  <div className="analytics-list-bar">
                    <span style={{ width: `${item.share * 100}%` }} />
                  </div>
                  <span className="analytics-mono">{item.count}</span>
                </div>
              ))}
            </div>
            <div className="analytics-list">
              <h4>高分 Verdict</h4>
              {highScore?.verdicts.map((item) => (
                <div key={item.verdict} className="analytics-list-row">
                  <span>{formatVerdict(item.verdict)}</span>
                  <div className="analytics-list-bar">
                    <span style={{ width: `${item.share * 100}%` }} />
                  </div>
                  <span className="analytics-mono">{item.count}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="analytics-split">
            <div className="analytics-subpanel">
              <h4>高分语言分布</h4>
              <table className="analytics-table">
                <thead>
                  <tr>
                    <th>语言</th>
                    <th>数量</th>
                    <th>占比</th>
                  </tr>
                </thead>
                <tbody>
                  {highScore?.languages.map((item) => (
                    <tr key={item.lang}>
                      <td>{item.lang}</td>
                      <td className="analytics-mono">{item.count}</td>
                      <td className="analytics-mono">{formatPercent(item.share, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="analytics-subpanel">
              <h4>高分长度分布</h4>
              <div className="analytics-bars compact">
                {highScore?.lengthBuckets.map((bucket) => (
                  <div key={bucket.label} className="analytics-bar-row">
                    <div className="analytics-bar-label">{bucket.label}</div>
                    <div className="analytics-bar">
                      <span style={{ width: `${bucket.share * 100}%` }} />
                    </div>
                    <div className="analytics-bar-meta analytics-mono">
                      <span>{bucket.count}</span>
                      <span>{formatPercent(bucket.share, 0)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
