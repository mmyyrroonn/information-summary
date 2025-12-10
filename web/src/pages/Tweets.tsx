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

export function TweetsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [tweets, setTweets] = useState<TweetRecord[]>([]);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'newest' | 'oldest' | 'priority'>('newest');
  const [subscriptionId, setSubscriptionId] = useState<string | undefined>(undefined);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
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
  }, [page, sort, subscriptionId, startTime, endTime]);

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
        subscriptionId,
        startTime: toIso(startTime),
        endTime: toIso(endTime)
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
    const pendingIds = tweets.filter((tweet) => !tweet.insights).map((tweet) => tweet.id);
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
  const pendingCount = tweets.filter((tweet) => !tweet.insights).length;
  const hasTimeFilter = Boolean(startTime || endTime);

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
          </div>
        </div>

        <div className="tweet-filters">
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
          </div>
        </div>

        <div className="tweet-list">
          {loading && <p className="empty">加载中...</p>}
          {!loading && tweets.length === 0 && <p className="empty">暂无推文</p>}
          {!loading &&
            tweets.map((tweet) => (
              <article key={tweet.id} className="tweet-card">
                <div className="tweet-meta">
                  <div>
                    <p className="tweet-author">
                      {tweet.authorName} <span>@{tweet.authorScreen}</span>
                    </p>
                    <p className="tweet-time">{new Date(tweet.tweetedAt).toLocaleString()}</p>
                  </div>
                  {tweet.tweetUrl && (
                    <a href={tweet.tweetUrl} target="_blank" rel="noreferrer">
                      查看原文
                    </a>
                  )}
                </div>
                <p className="tweet-text">{tweet.text}</p>
                <div className={`tweet-analysis ${tweet.insights ? 'has-insight' : ''}`}>
                  {tweet.insights ? (
                    <>
                      <div className="tweet-pill-row">
                        <span className={`pill verdict ${tweet.insights.verdict}`}>{formatVerdict(tweet.insights.verdict)}</span>
                        {typeof tweet.insights.importance === 'number' && (
                          <span className="pill importance">优先级 {tweet.insights.importance}</span>
                        )}
                      </div>
                      {tweet.insights.summary && <p className="tweet-summary">{tweet.insights.summary}</p>}
                      {tweet.insights.tags?.length ? <p className="tweet-tags">标签：{tweet.insights.tags.join(' / ')}</p> : null}
                      {tweet.insights.suggestions && <p className="tweet-suggestion">建议：{tweet.insights.suggestions}</p>}
                    </>
                  ) : (
                    <p className="tweet-summary">暂无 AI 分析</p>
                  )}
                </div>
              </article>
            ))}
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
