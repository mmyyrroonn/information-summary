import { Dispatch, FormEvent, SetStateAction, useEffect, useState } from 'react';
import { api } from '../api';
import type { Subscription, SubscriptionImportResult, SubscriptionStatus, SubscriptionTweetStats } from '../types';

function normalizeHandle(value: string) {
  return value.replace(/^@/, '').trim().toLowerCase();
}

interface ParsedEntry {
  screenName: string;
  displayName?: string;
}

function parseBulkInput(input: string): ParsedEntry[] {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const entries: ParsedEntry[] = [];

  for (const line of lines) {
    let handle = '';
    let note = '';
    if (line.includes(',')) {
      const [first, ...rest] = line.split(',');
      handle = normalizeHandle(first ?? '');
      note = rest.join(',').trim();
    } else {
      const [first, ...rest] = line.split(/\s+/);
      handle = normalizeHandle(first ?? '');
      note = rest.join(' ').trim();
    }
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    entries.push({ screenName: handle, displayName: note || undefined });
  }

  return entries;
}

export function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [form, setForm] = useState({ screenName: '', displayName: '' });
  const [bulkInput, setBulkInput] = useState('');
  const [bulkResult, setBulkResult] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [listImportForm, setListImportForm] = useState({ listId: '', cursor: '' });
  const [listImportLogs, setListImportLogs] = useState<string[]>([]);
  const [followingImportForm, setFollowingImportForm] = useState({ screenName: '', userId: '', cursor: '' });
  const [followingImportLogs, setFollowingImportLogs] = useState<string[]>([]);
  const [statsById, setStatsById] = useState<Record<string, SubscriptionTweetStats>>({});
  const [highScoreMinImportance, setHighScoreMinImportance] = useState<number>(4);

  useEffect(() => {
    refreshSubscriptions();
  }, []);

  async function refreshSubscriptions() {
    const [subsResult, statsResult] = await Promise.allSettled([api.listSubscriptions(), api.getSubscriptionStats()]);
    if (subsResult.status === 'fulfilled') {
      setSubscriptions(subsResult.value);
    } else {
      setStatusMessage(subsResult.reason instanceof Error ? subsResult.reason.message : '加载订阅失败');
    }
    if (statsResult.status === 'fulfilled') {
      setHighScoreMinImportance(statsResult.value.highScoreMinImportance);
      const next: Record<string, SubscriptionTweetStats> = {};
      for (const item of statsResult.value.items) {
        next[item.subscriptionId] = item;
      }
      setStatsById(next);
    } else {
      setStatsById({});
    }
  }

  async function handleAddSubscription(event: FormEvent) {
    event.preventDefault();
    if (!form.screenName.trim()) return;
    setBusy('add-single');
    try {
      await api.createSubscription({
        screenName: form.screenName,
        displayName: form.displayName || undefined
      });
      setForm({ screenName: '', displayName: '' });
      setStatusMessage('添加成功');
      await refreshSubscriptions();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '添加失败');
    } finally {
      setBusy(null);
    }
  }

  async function handleBulkAdd() {
    const entries = parseBulkInput(bulkInput);
    if (!entries.length) {
      setBulkResult('请输入至少一个账号');
      return;
    }
    setBusy('add-bulk');
    let success = 0;
    const failures: string[] = [];
    for (const entry of entries) {
      try {
        await api.createSubscription({ screenName: entry.screenName, displayName: entry.displayName });
        success += 1;
      } catch (error) {
        failures.push(`${entry.screenName}: ${error instanceof Error ? error.message : '失败'}`);
      }
    }
    await refreshSubscriptions();
    setBulkInput('');
    setBulkResult(`成功 ${success} 条，失败 ${failures.length} 条${failures.length ? `\n${failures.join('\n')}` : ''}`);
    setBusy(null);
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

  async function handleFetchSubscription(sub: Subscription) {
    setBusy(`fetch-${sub.id}`);
    try {
      const isUnsubscribed = sub.status === 'UNSUBSCRIBED';
      const allowUnsubscribed = isUnsubscribed ? confirm('该账号已“不再订阅”，仍要抓取一次推文吗？') : false;
      if (isUnsubscribed && !allowUnsubscribed) {
        return;
      }
      const result = await api.fetchSubscription(sub.id, { allowUnsubscribed: isUnsubscribed ? true : undefined });
      setStatusMessage(`已抓取 ${result.inserted} 条推文`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '抓取失败');
    } finally {
      setBusy(null);
    }
  }

  async function handleSetStatus(sub: Subscription, status: SubscriptionStatus) {
    const nextStatusText = status === 'UNSUBSCRIBED' ? '不再订阅' : '恢复订阅';
    if (status === 'UNSUBSCRIBED' && !confirm(`确定要将 @${sub.screenName} 设置为“不再订阅”吗？`)) {
      return;
    }
    setBusy(`status-${sub.id}`);
    try {
      await api.updateSubscriptionStatus(sub.id, status);
      setStatusMessage(`${nextStatusText}成功`);
      await refreshSubscriptions();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : `${nextStatusText}失败`);
    } finally {
      setBusy(null);
    }
  }

  function formatImportResult(source: string, identifier: string, result: SubscriptionImportResult) {
    const timestamp = new Date().toLocaleTimeString();
    const summary = `[${timestamp}] ${source} ${identifier}｜获取 ${result.fetched}，新增 ${result.created}，已存在 ${result.existing}，跳过 ${result.skipped}，nextCursor=${
      result.nextCursor ?? '无'
    }，${result.hasMore ? '还有更多' : '没有更多'}`;
    if (!result.users.length) return summary;
    const detail = result.users
      .map((user, index) => {
        const label = user.created ? '新增 ✅' : '已存在';
        const name = user.displayName ? `（${user.displayName}）` : '';
        return `${index + 1}. @${user.screenName}${name} - ${label}`;
      })
      .join('\n');
    return `${summary}\n${detail}`;
  }

  function appendLog(setter: Dispatch<SetStateAction<string[]>>, entry: string) {
    setter((prev) => [entry, ...prev].slice(0, 20));
  }

  async function handleListImport() {
    if (!listImportForm.listId.trim()) {
      setStatusMessage('请输入 List ID');
      return;
    }
    setBusy('import-list');
    try {
      const result = await api.importListMembers({
        listId: listImportForm.listId.trim(),
        cursor: listImportForm.cursor.trim() || undefined
      });
      appendLog(setListImportLogs, formatImportResult('List', listImportForm.listId.trim(), result));
      setListImportForm((prev) => ({ ...prev, cursor: result.nextCursor ?? '' }));
      setStatusMessage(`List 导入完成，本页新增 ${result.created} 条订阅`);
      await refreshSubscriptions();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'List 导入失败');
    } finally {
      setBusy(null);
    }
  }

  async function handleFollowingImport() {
    const screenName = followingImportForm.screenName.trim();
    const userId = followingImportForm.userId.trim();
    if (!screenName && !userId) {
      setStatusMessage('请输入 @账号或用户 ID');
      return;
    }
    setBusy('import-following');
    try {
      const payload: { screenName?: string; userId?: string; cursor?: string } = {};
      if (screenName) payload.screenName = screenName;
      if (userId) payload.userId = userId;
      if (followingImportForm.cursor.trim()) payload.cursor = followingImportForm.cursor.trim();
      const identifier = screenName ? `@${screenName}` : userId;
      const result = await api.importFollowingUsers(payload);
      appendLog(setFollowingImportLogs, formatImportResult('关注', identifier, result));
      setFollowingImportForm((prev) => ({ ...prev, cursor: result.nextCursor ?? '' }));
      setStatusMessage(`关注导入完成，本页新增 ${result.created} 条订阅`);
      await refreshSubscriptions();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '关注导入失败');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {statusMessage && <p className="status">{statusMessage}</p>}
      <section>
        <div className="section-head">
          <div>
            <h2>单个添加订阅</h2>
            <p className="hint">输入 Twitter 账号及可选备注。</p>
          </div>
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
          <button type="submit" disabled={busy === 'add-single'}>
            {busy === 'add-single' ? '添加中...' : '添加订阅'}
          </button>
        </form>
      </section>

      <section>
        <div className="section-head">
          <div>
            <h2>批量导入订阅</h2>
            <p className="hint">支持粘贴多个账号，逗号或换行分隔，自动去重。</p>
          </div>
          <button onClick={handleBulkAdd} disabled={busy === 'add-bulk'}>
            {busy === 'add-bulk' ? '导入中...' : '开始导入'}
          </button>
        </div>
        <textarea
          className="bulk-input"
          rows={6}
          placeholder={'示例：\n@cmdefi\nelonmusk 马斯克\nkol_01, 备注信息'}
          value={bulkInput}
          onChange={(e) => setBulkInput(e.target.value)}
        />
        {bulkResult && <pre className="bulk-result">{bulkResult}</pre>}
      </section>

      <section>
        <div className="section-head">
          <div>
            <h2>从 Twitter List 导入</h2>
            <p className="hint">输入 list_id，逐页抓取成员并自动订阅，cursor 可用于继续下一页。</p>
          </div>
          <button onClick={handleListImport} disabled={busy === 'import-list'}>
            {busy === 'import-list' ? '导入中...' : '获取并订阅'}
          </button>
        </div>
        <div className="subscription-form">
          <input
            placeholder="List ID"
            value={listImportForm.listId}
            onChange={(e) => setListImportForm((prev) => ({ ...prev, listId: e.target.value }))}
          />
          <input
            placeholder="Cursor（可选）"
            value={listImportForm.cursor}
            onChange={(e) => setListImportForm((prev) => ({ ...prev, cursor: e.target.value }))}
          />
        </div>
        {listImportLogs.length > 0 && <pre className="bulk-result">{listImportLogs.join('\n\n')}</pre>}
      </section>

      <section>
        <div className="section-head">
          <div>
            <h2>导入某账号的 Following</h2>
            <p className="hint">输入 @账号或用户 ID，逐页抓取其关注列表并订阅，可用 cursor 分批执行。</p>
          </div>
          <button onClick={handleFollowingImport} disabled={busy === 'import-following'}>
            {busy === 'import-following' ? '导入中...' : '获取并订阅'}
          </button>
        </div>
        <div className="subscription-form">
          <input
            placeholder="@账号（可选）"
            value={followingImportForm.screenName}
            onChange={(e) =>
              setFollowingImportForm((prev) => ({ ...prev, screenName: normalizeHandle(e.target.value) }))
            }
          />
          <input
            placeholder="用户 ID（可选）"
            value={followingImportForm.userId}
            onChange={(e) => setFollowingImportForm((prev) => ({ ...prev, userId: e.target.value.trim() }))}
          />
          <input
            placeholder="Cursor（可选）"
            value={followingImportForm.cursor}
            onChange={(e) => setFollowingImportForm((prev) => ({ ...prev, cursor: e.target.value }))}
          />
        </div>
        {followingImportLogs.length > 0 && <pre className="bulk-result">{followingImportLogs.join('\n\n')}</pre>}
      </section>

      <section>
        <div className="section-head">
          <div>
            <h2>订阅列表</h2>
            <p className="hint">
              总人数 {subscriptions.length}，已订阅 {subscriptions.filter((s) => s.status !== 'UNSUBSCRIBED').length}，不再订阅{' '}
              {subscriptions.filter((s) => s.status === 'UNSUBSCRIBED').length}
            </p>
          </div>
        </div>
        {subscriptions.length === 0 ? (
          <p className="empty list-empty">暂无订阅</p>
        ) : (
          <div className="list">
            {subscriptions.map((sub) => {
              const stats = statsById[sub.id];
              return (
                <div key={sub.id} className="list-item">
                  <div>
                    <p className="title">@{sub.screenName}</p>
                    {sub.displayName && <p className="subtitle">{sub.displayName}</p>}
                    {sub.status === 'UNSUBSCRIBED' && (
                      <p className="meta">
                        状态：不再订阅{sub.unsubscribedAt ? `（${new Date(sub.unsubscribedAt).toLocaleString()}）` : ''}
                      </p>
                    )}
                    {sub.lastFetchedAt && <p className="meta">上次抓取：{new Date(sub.lastFetchedAt).toLocaleString()}</p>}
                    {stats && (
                      <p className="meta">
                        统计：均分 {typeof stats.avgImportance === 'number' ? stats.avgImportance.toFixed(2) : '-'}（n={stats.scoredTweets}）｜平均推文/天{' '}
                        {typeof stats.avgTweetsPerDay === 'number' ? stats.avgTweetsPerDay.toFixed(2) : '-'}｜高分占比（≥{highScoreMinImportance}）{' '}
                        {typeof stats.highScoreRatio === 'number' ? `${(stats.highScoreRatio * 100).toFixed(1)}%` : '-'}
                      </p>
                    )}
                  </div>
                  <div className="item-actions">
                    {sub.status === 'UNSUBSCRIBED' ? (
                      <button
                        onClick={() => handleSetStatus(sub, 'SUBSCRIBED')}
                        disabled={busy === `status-${sub.id}`}
                      >
                        {busy === `status-${sub.id}` ? '处理中' : '恢复订阅'}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleSetStatus(sub, 'UNSUBSCRIBED')}
                        disabled={busy === `status-${sub.id}`}
                        className="danger"
                      >
                        {busy === `status-${sub.id}` ? '处理中' : '不再订阅'}
                      </button>
                    )}
                    <button onClick={() => handleFetchSubscription(sub)} disabled={busy === `fetch-${sub.id}`}>
                      {busy === `fetch-${sub.id}` ? '抓取中' : '抓取'}
                    </button>
                    <button
                      onClick={() => handleDeleteSubscription(sub.id)}
                      disabled={busy === `delete-${sub.id}`}
                      className="danger"
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
