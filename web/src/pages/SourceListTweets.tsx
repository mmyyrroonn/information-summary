import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { SourceList, TweetMedia, TweetRecord } from '../types';
import { buildSourcePeople, resolveSourceListSelection } from './sourceListTweetFilters';

const PAGE_SIZE = 12;

function formatDateTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value ?? '';
  return date.toLocaleString();
}

function formatVerdict(value?: string | null) {
  switch (value) {
    case 'actionable':
      return 'Actionable';
    case 'watch':
      return 'Watch';
    case 'ignore':
      return 'Ignore';
    default:
      return value ?? '待分析';
  }
}

function formatMediaTypeLabel(type: TweetMedia['type']) {
  switch (type) {
    case 'video':
      return '视频';
    case 'animated_gif':
      return 'GIF';
    default:
      return '';
  }
}

function SourceTweetMediaPreview({ tweet }: { tweet: TweetRecord }) {
  const mediaItems = tweet.media?.slice(0, 4) ?? [];
  if (!mediaItems.length) {
    return null;
  }

  return (
    <div className={`source-tweet-media source-tweet-media-${mediaItems.length}`}>
      {mediaItems.map((media, index) => {
        const label = formatMediaTypeLabel(media.type);
        return (
          <a
            key={`${media.url}-${index}`}
            className="source-tweet-media-item"
            href={media.expandedUrl ?? media.url}
            target="_blank"
            rel="noreferrer"
            title={media.expandedUrl ?? media.shortUrl ?? media.url}
          >
            <img
              src={media.url}
              alt={`${tweet.authorName} 推文媒体 ${index + 1}`}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
            />
            {label ? <span>{label}</span> : null}
          </a>
        );
      })}
    </div>
  );
}

export function SourceListTweetsPage() {
  const [sourceLists, setSourceLists] = useState<SourceList[]>([]);
  const [selectedListId, setSelectedListId] = useState('');
  const [sourceList, setSourceList] = useState<SourceList | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [tweets, setTweets] = useState<TweetRecord[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listsLoading, setListsLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tweetsLoading, setTweetsLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const tweetRequestId = useRef(0);

  const loadTweets = useCallback(async () => {
    if (!selectedListId) {
      return;
    }
    const requestId = tweetRequestId.current + 1;
    tweetRequestId.current = requestId;
    setTweetsLoading(true);
    try {
      const response = await api.listTweets({
        page,
        pageSize: PAGE_SIZE,
        includeTotal: false,
        sort,
        routing: 'all',
        sourceListId: selectedListId,
        sourceId: selectedSourceId || undefined
      });
      if (tweetRequestId.current !== requestId) return;
      setTweets(response.items);
      setTotal(response.total);
      setHasMore(response.hasMore);
    } catch (error) {
      if (tweetRequestId.current !== requestId) return;
      setTweets([]);
      setTotal(null);
      setHasMore(false);
      setStatusMessage(error instanceof Error ? error.message : '加载推文失败');
    } finally {
      if (tweetRequestId.current === requestId) {
        setTweetsLoading(false);
      }
    }
  }, [page, selectedListId, selectedSourceId, sort]);

  useEffect(() => {
    loadSourceLists();
  }, []);

  useEffect(() => {
    if (!selectedListId) {
      setSourceList(null);
      setSelectedSourceId('');
      setTweets([]);
      setTotal(null);
      setHasMore(false);
      return;
    }
    loadSourceListDetail(selectedListId);
  }, [selectedListId]);

  useEffect(() => {
    loadTweets();
  }, [loadTweets]);

  const people = useMemo(() => buildSourcePeople(sourceList), [sourceList]);
  const selectedList = sourceLists.find((list) => list.id === selectedListId) ?? sourceList;
  const selectedPerson = people.find((person) => person.id === selectedSourceId) ?? null;
  const totalPages = total === null ? null : Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function loadSourceLists() {
    setListsLoading(true);
    try {
      const lists = await api.listSourceLists();
      setSourceLists(lists);
      setSelectedListId((current) => resolveSourceListSelection(lists, current));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载 SourceList 失败');
    } finally {
      setListsLoading(false);
    }
  }

  async function loadSourceListDetail(listId: string) {
    setDetailLoading(true);
    try {
      const detail = await api.getSourceList(listId);
      const nextPeople = buildSourcePeople(detail);
      setSourceList(detail);
      setSelectedSourceId((current) => (current && nextPeople.some((person) => person.id === current) ? current : ''));
      setPage(1);
    } catch (error) {
      setSourceList(null);
      setSelectedSourceId('');
      setStatusMessage(error instanceof Error ? error.message : '加载 SourceList 成员失败');
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <>
      {statusMessage && <p className="status">{statusMessage}</p>}
      <section className="source-tweets-section">
        <div className="section-head">
          <div>
            <h2>SourceList 推文</h2>
            <p className="hint">按列表和成员查看推文时间线。</p>
          </div>
          <div className="source-tweets-actions">
            <button type="button" className="ghost" onClick={loadSourceLists} disabled={listsLoading}>
              {listsLoading ? '刷新中...' : '刷新列表'}
            </button>
            <button type="button" onClick={loadTweets} disabled={!selectedListId || tweetsLoading}>
              {tweetsLoading ? '刷新中...' : '刷新推文'}
            </button>
          </div>
        </div>

        <div className="source-tweets-toolbar">
          <label>
            <span>SourceList</span>
            <select
              value={selectedListId}
              onChange={(event) => {
                setSelectedListId(event.target.value);
                setSelectedSourceId('');
                setPage(1);
              }}
              disabled={listsLoading || sourceLists.length === 0}
            >
              {sourceLists.length === 0 ? <option value="">暂无 SourceList</option> : null}
              {sourceLists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                  {list._count ? ` · ${list._count.sources} 人` : ''}
                  {list.enabled ? '' : ' · 停用'}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>时间排序</span>
            <select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as 'newest' | 'oldest');
                setPage(1);
              }}
            >
              <option value="newest">最新在前</option>
              <option value="oldest">最早在前</option>
            </select>
          </label>

          <div className="source-tweets-metrics">
            <span>{selectedList?.name ?? '未选择列表'}</span>
            <strong>{total === null ? '-' : total}</strong>
            <span>条推文</span>
          </div>
        </div>

        <div className="source-tweets-layout">
          <aside className="source-people-panel" aria-label="SourceList 成员">
            <div className="source-people-head">
              <span>成员</span>
              <strong>{detailLoading ? '...' : people.length}</strong>
            </div>
            <button
              type="button"
              className={`source-person-row${selectedSourceId ? '' : ' active'}`}
              onClick={() => {
                setSelectedSourceId('');
                setPage(1);
              }}
              disabled={!selectedListId || detailLoading}
            >
              <span className="source-person-name">全部成员</span>
              <span className="source-person-meta">{people.length} 人</span>
            </button>
            {people.map((person) => (
              <button
                key={person.id}
                type="button"
                className={`source-person-row${selectedSourceId === person.id ? ' active' : ''}`}
                onClick={() => {
                  setSelectedSourceId(person.id);
                  setPage(1);
                }}
              >
                <span className="source-person-name">{person.label}</span>
                <span className="source-person-meta">{person.subtitle}</span>
              </button>
            ))}
            {!detailLoading && selectedListId && people.length === 0 ? (
              <p className="empty">这个 SourceList 暂无 Twitter 成员</p>
            ) : null}
          </aside>

          <div className="source-tweet-feed">
            <div className="source-tweet-summary">
              <span>{selectedPerson ? `${selectedPerson.label} ${selectedPerson.handle}` : '全部成员'}</span>
              <span>本页 {tweets.length} 条</span>
              <span>{sort === 'newest' ? '最新在前' : '最早在前'}</span>
            </div>

            <div className="source-tweet-list">
              {tweetsLoading && <p className="empty">加载中...</p>}
              {!tweetsLoading && tweets.length === 0 && <p className="empty">暂无推文</p>}
              {!tweetsLoading &&
                tweets.map((tweet) => (
                  <article
                    key={tweet.id}
                    className={`source-tweet-card${
                      tweet.insights?.verdict ? ` source-tweet-card-${tweet.insights.verdict}` : ''
                    }`}
                  >
                    <div className="source-tweet-card-head">
                      <div>
                        <p className="source-tweet-author">
                          {tweet.authorName} <span>@{tweet.authorScreen}</span>
                        </p>
                        <p className="source-tweet-time">{formatDateTime(tweet.tweetedAt)}</p>
                      </div>
                      {tweet.tweetUrl ? (
                        <a className="source-tweet-link" href={tweet.tweetUrl} target="_blank" rel="noreferrer">
                          原文
                        </a>
                      ) : null}
                    </div>

                    <p className="source-tweet-text">{tweet.text}</p>
                    <SourceTweetMediaPreview tweet={tweet} />

                    <div className={`source-tweet-insight${tweet.insights ? ' has-insight' : ''}`}>
                      <div className="tweet-pill-row">
                        <span className={`pill verdict ${tweet.insights?.verdict ?? ''}`}>
                          {formatVerdict(tweet.insights?.verdict)}
                        </span>
                        {typeof tweet.insights?.importance === 'number' ? (
                          <span className="pill importance">优先级 {tweet.insights.importance}</span>
                        ) : null}
                        {tweet.routingTag ? <span className="pill tag">{tweet.routingTag}</span> : null}
                      </div>
                      {tweet.insights?.summary ? (
                        <p className="source-tweet-summary-text">{tweet.insights.summary}</p>
                      ) : (
                        <p className="source-tweet-summary-text">暂无 AI 摘要</p>
                      )}
                      {tweet.insights?.suggestions ? (
                        <p className="source-tweet-suggestion">建议：{tweet.insights.suggestions}</p>
                      ) : null}
                    </div>
                  </article>
                ))}
            </div>

            <div className="tweet-pagination">
              <button onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={page === 1 || tweetsLoading}>
                上一页
              </button>
              <span className="tweet-pagination-info">
                第 {page}
                {totalPages !== null ? (
                  <>
                    {' '}
                    /{' '}
                    <button type="button" onClick={() => setPage(totalPages)} disabled={page === totalPages || tweetsLoading}>
                      {totalPages}
                    </button>{' '}
                    页
                  </>
                ) : (
                  <> 页</>
                )}{' '}
                · {total === null ? '总数未加载' : `共 ${total} 条`}
              </span>
              <button onClick={() => hasMore && setPage((prev) => prev + 1)} disabled={!hasMore || tweetsLoading}>
                下一页
              </button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
