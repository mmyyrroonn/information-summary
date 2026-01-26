import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Subscription, TweetRecord } from '../types';

const PAGE_SIZE = 20;

function formatVerdict(value?: string | null) {
  switch (value) {
    case 'actionable':
      return 'Actionable';
    case 'watch':
      return 'Watch';
    case 'ignore':
      return 'Ignore';
    default:
      return value ?? '未知';
  }
}

const TAG_LABELS: Record<string, string> = {
  policy: '政策 / 合规',
  macro: '宏观 / 行情',
  security: '安全 / 风险',
  funding: '融资 / 资金',
  yield: '收益 / 理财',
  token: '代币 / 市场',
  airdrop: '空投 / 福利',
  trading: '交易机会',
  onchain: '链上数据',
  tech: '技术 / 升级',
  exchange: '交易所 / 平台',
  narrative: '叙事 / 主题',
  other: '其他'
};

const ROUTING_STATUS_LABELS: Record<string, string> = {
  PENDING: '待路由',
  IGNORED: '规则过滤',
  AUTO_HIGH: '自动高优',
  ROUTED: '已路由',
  LLM_QUEUED: '待 LLM'
};

const ROUTING_REASON_LABELS: Record<string, string> = {
  'low-lang': '低价值语言',
  'low-info-short': '信息不足',
  'rule-drop': '规则过滤',
  'embed-high': '相似度高',
  'embed-no-cache': '无缓存向量',
  'embed-missing': '缺失向量',
  'embed-unrouted': '未命中路由'
};

const ABANDON_REASON_LABELS: Record<string, string> = {
  'content-risk': '内容风控',
  'max-retries': '多次失败',
  unknown: '未知错误'
};

function formatTagLabel(tag?: string | null) {
  if (!tag) return '';
  return TAG_LABELS[tag] ?? tag;
}

function formatRoutingStatus(value?: string | null) {
  if (!value) return '';
  return ROUTING_STATUS_LABELS[value] ?? value;
}

function formatRoutingReason(value?: string | null) {
  if (!value) return '';
  return ROUTING_REASON_LABELS[value] ?? value;
}

function formatAbandonReason(value?: string | null) {
  if (!value) return '';
  return ABANDON_REASON_LABELS[value] ?? value;
}

function formatDateTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value ?? '';
  return date.toLocaleString();
}

function buildRoutingLine(tweet: TweetRecord) {
  const parts: string[] = [];
  const statusLabel = formatRoutingStatus(tweet.routingStatus);
  if (statusLabel) {
    parts.push(`路由：${statusLabel}`);
  }
  if (tweet.routingTag) {
    parts.push(`标签：${formatTagLabel(tweet.routingTag)}`);
  }
  if (typeof tweet.routingScore === 'number') {
    parts.push(`相似度 ${tweet.routingScore.toFixed(2)}`);
  }
  if (typeof tweet.routingMargin === 'number') {
    parts.push(`差值 ${tweet.routingMargin.toFixed(2)}`);
  }
  if (tweet.routingReason) {
    parts.push(`原因 ${formatRoutingReason(tweet.routingReason)}`);
  }
  return parts.join(' · ');
}

export function TweetsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [tweets, setTweets] = useState<TweetRecord[]>([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'newest' | 'oldest' | 'priority'>('newest');
  const [routingView, setRoutingView] = useState<'default' | 'ignored'>('default');
  const [subscriptionId, setSubscriptionId] = useState<string | undefined>(undefined);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [search, setSearch] = useState('');
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    loadSubscriptions();
  }, []);

  useEffect(() => {
    loadTweets();
  }, [page, sort, subscriptionId, startTime, endTime, search, routingView]);

  async function loadSubscriptions() {
    try {
      const subs = await api.listSubscriptions();
      setSubscriptions(subs);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载订阅失败');
    }
  }

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

  async function loadTweets() {
    setLoading(true);
    try {
      const response = await api.listTweets({
        page,
        pageSize: PAGE_SIZE,
        sort,
        routing: routingView,
        subscriptionId,
        startTime: toIso(startTime),
        endTime: toIso(endTime),
        q: search.trim() || undefined
      });
      setTweets(response.items);
      setTotal(response.total);
      setHasMore(response.hasMore);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载推文失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleAnalyzeMissing() {
    const pendingIds = tweets.filter((tweet) => !tweet.insights && !tweet.abandonedAt).map((tweet) => tweet.id);
    if (!pendingIds.length) {
      setStatusMessage('当前页面推文均已完成 AI 分析');
      return;
    }
    setAnalyzing(true);
    try {
      const result = await api.analyzeTweets(pendingIds);
      setStatusMessage(`AI 已处理 ${result.insights} 条推文`);
      await loadTweets();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '分析失败');
    } finally {
      setAnalyzing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pendingCount = tweets.filter((tweet) => !tweet.insights && !tweet.abandonedAt).length;
  const hasTimeFilter = Boolean(startTime || endTime);
  const timeLabel = hasTimeFilter
    ? `${formatDateTime(startTime) || '最早'} ~ ${formatDateTime(endTime) || '现在'}`
    : search.trim()
      ? '近 24 小时'
      : '不限';
  const routingLabel = routingView === 'ignored' ? '规则过滤' : '默认';

  function clearTimeRange() {
    if (!hasTimeFilter) {
      return;
    }
    setStartTime('');
    setEndTime('');
    setPage(1);
  }

  return (
    <>
      {statusMessage && <p className="status">{statusMessage}</p>}
      <section className="tweet-section">
        <div className="section-head">
          <div>
            <h2>推文浏览</h2>
            <p className="hint">筛选账号、按优先级或时间过滤，并查看对应的 AI 洞察。</p>
          </div>
          <div className="tweet-actions">
            <button onClick={() => loadTweets()} disabled={loading}>
              {loading ? '刷新中...' : '刷新列表'}
            </button>
            <button onClick={handleAnalyzeMissing} disabled={analyzing || !pendingCount || loading}>
              {analyzing ? 'AI 分析中...' : `分析本页缺失 (${pendingCount})`}
            </button>
            <button
              type="button"
              className={`ghost tweet-toggle${routingView === 'ignored' ? ' active' : ''}`}
              onClick={() => {
                setRoutingView((prev) => (prev === 'ignored' ? 'default' : 'ignored'));
                setPage(1);
              }}
              disabled={loading}
            >
              {routingView === 'ignored' ? '返回默认列表' : '查看规则过滤'}
            </button>
          </div>
        </div>

        <div className="tweet-filters">
          <label>
            <span>内容搜索</span>
            <input
              type="text"
              value={search}
              placeholder="关键词搜索（默认近24h，逗号=AND，分号=OR）"
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </label>

          <label>
            <span>订阅账号</span>
            <select
              value={subscriptionId ?? ''}
              onChange={(e) => {
                setSubscriptionId(e.target.value || undefined);
                setPage(1);
              }}
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
            <span>排序方式</span>
            <select
              value={sort}
              onChange={(e) => {
                setSort(e.target.value as 'newest' | 'oldest' | 'priority');
                setPage(1);
              }}
            >
              <option value="newest">最新优先</option>
              <option value="oldest">最早优先</option>
              <option value="priority">最高优先级</option>
            </select>
          </label>

          <div className="tweet-range">
            <span>时间范围</span>
            <div className="tweet-range-inputs">
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  setPage(1);
                }}
              />
              <span className="tweet-range-sep">至</span>
              <input
                type="datetime-local"
                value={endTime}
                onChange={(e) => {
                  setEndTime(e.target.value);
                  setPage(1);
                }}
              />
              <button type="button" className="ghost" onClick={clearTimeRange} disabled={!hasTimeFilter}>
                清除
              </button>
            </div>
            <p className="hint">未设时间范围时，搜索默认近 24 小时。</p>
          </div>
        </div>

        <div className="tweet-summary-row">
          <span>共 {total} 条</span>
          <span>本页 {tweets.length} 条</span>
          <span>待分析 {pendingCount} 条</span>
          <span>时间范围：{timeLabel}</span>
          <span>模式：{routingLabel}</span>
          {search.trim() ? <span>关键词：{search.trim()}</span> : null}
        </div>

        <div className="tweet-list">
          {loading && <p className="empty">加载中...</p>}
          {!loading && tweets.length === 0 && <p className="empty">暂无推文</p>}
          {!loading &&
            tweets.map((tweet) => {
              const routingLine = buildRoutingLine(tweet);
              const analysisFailed = Boolean(tweet.abandonedAt);
              const routingStatusLabel = formatRoutingStatus(tweet.routingStatus);
              const pendingLabel = analysisFailed ? '分析失败' : routingStatusLabel || '待分析';
              const pendingClass = analysisFailed ? 'failed' : 'pending';
              const insightUpdatedAt = tweet.insights?.updatedAt;
              return (
                <article
                  key={tweet.id}
                  className={`tweet-card${tweet.insights?.verdict ? ` tweet-card-${tweet.insights.verdict}` : ''}`}
                >
                <div className="tweet-meta">
                  <div>
                    <p className="tweet-author">
                      {tweet.authorName} <span>@{tweet.authorScreen}</span>
                    </p>
                    <p className="tweet-time">{formatDateTime(tweet.tweetedAt)}</p>
                  </div>
                  {tweet.tweetUrl && (
                    <a href={tweet.tweetUrl} target="_blank" rel="noreferrer">
                      查看原文
                    </a>
                  )}
                </div>
                <p className="tweet-text">{tweet.text}</p>
                {routingLine ? <p className="tweet-routing">{routingLine}</p> : null}
                <div className={`tweet-analysis ${tweet.insights ? 'has-insight' : ''}`}>
                  {tweet.insights ? (
                    <>
                      <div className="tweet-pill-row">
                        <span className={`pill verdict ${tweet.insights.verdict}`}>{formatVerdict(tweet.insights.verdict)}</span>
                        {typeof tweet.insights.importance === 'number' && (
                          <span className="pill importance">优先级 {tweet.insights.importance}</span>
                        )}
                        {tweet.insights.tags?.length
                          ? tweet.insights.tags.map((tag) => (
                              <span key={tag} className="pill tag" title={tag}>
                                {formatTagLabel(tag)}
                              </span>
                            ))
                          : null}
                      </div>
                      {tweet.insights.summary && <p className="tweet-summary">{tweet.insights.summary}</p>}
                      {tweet.insights.suggestions && <p className="tweet-suggestion">建议：{tweet.insights.suggestions}</p>}
                      {insightUpdatedAt ? <p className="tweet-analysis-meta">AI 更新时间：{formatDateTime(insightUpdatedAt)}</p> : null}
                    </>
                  ) : (
                    <>
                      <div className="tweet-pill-row">
                        <span className={`pill status ${pendingClass}`}>{pendingLabel}</span>
                      </div>
                      <p className="tweet-summary">暂无 AI 分析</p>
                      {analysisFailed ? (
                        <p className="tweet-suggestion">
                          失败原因：{formatAbandonReason(tweet.abandonReason) || '未知'}{tweet.abandonedAt ? ` · ${formatDateTime(tweet.abandonedAt)}` : ''}
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
              );
            })}
        </div>

        <div className="tweet-pagination">
          <button onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={page === 1 || loading}>
            上一页
          </button>
          <span className="tweet-pagination-info">
            第 {page} /{' '}
            <button type="button" onClick={() => setPage(totalPages)} disabled={page === totalPages || loading}>
              {totalPages}
            </button>{' '}
            页 · 共 {total} 条
          </span>
          <button onClick={() => hasMore && setPage((prev) => prev + 1)} disabled={!hasMore || loading}>
            下一页
          </button>
        </div>
      </section>
    </>
  );
}
