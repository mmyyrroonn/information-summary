import { Dispatch, FormEvent, SetStateAction, useEffect, useState } from 'react';
import { api } from '../api';
import type {
  AutoUnsubscribeCandidate,
  AutoUnsubscribeResponse,
  Subscription,
  SubscriptionImportResult,
  SubscriptionStatus,
  SubscriptionTweetStats
} from '../types';

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
  const [statsItems, setStatsItems] = useState<SubscriptionTweetStats[]>([]);
  const [highScoreMinImportance, setHighScoreMinImportance] = useState<number>(4);
  const [includeUnsubscribedInStats, setIncludeUnsubscribedInStats] = useState(false);
  const [autoRule, setAutoRule] = useState({
    minAvgImportance: 3.0,
    minHighScoreTweets: 6,
    minHighScoreRatio: 0.25,
    highScoreMinImportance: 4
  });
  const [autoResult, setAutoResult] = useState<AutoUnsubscribeResponse | null>(null);

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
      setAutoRule((prev) => ({ ...prev, highScoreMinImportance: statsResult.value.highScoreMinImportance }));
      const next: Record<string, SubscriptionTweetStats> = {};
      for (const item of statsResult.value.items) {
        next[item.subscriptionId] = item;
      }
      setStatsById(next);
      setStatsItems(statsResult.value.items);
    } else {
      setStatsById({});
      setStatsItems([]);
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

  async function handleAutoUnsubscribe(dryRun: boolean) {
    if (!dryRun) {
      const ok = confirm(
        `将按规则批量“取消订阅”不满足条件的账号：\n- 均分 ≥ ${autoRule.minAvgImportance}\n- 或 高分数量 ≥ ${autoRule.minHighScoreTweets}（importance≥${autoRule.highScoreMinImportance}）\n- 或 高分占比 > ${Math.round(
          autoRule.minHighScoreRatio * 100
        )}%\n\n确定执行吗？`
      );
      if (!ok) return;
    }

    setBusy(dryRun ? 'auto-preview' : 'auto-apply');
    try {
      const result = await api.autoUnsubscribe({
        minAvgImportance: autoRule.minAvgImportance,
        minHighScoreTweets: autoRule.minHighScoreTweets,
        minHighScoreRatio: autoRule.minHighScoreRatio,
        highScoreMinImportance: autoRule.highScoreMinImportance,
        dryRun
      });
      setAutoResult(result);
      setStatusMessage(
        dryRun
          ? `预览完成：将取消订阅 ${result.willUnsubscribe} 人`
          : `执行完成：已取消订阅 ${result.updated} 人（候选 ${result.willUnsubscribe} 人）`
      );
      if (!dryRun) {
        await refreshSubscriptions();
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '批量取消订阅失败');
    } finally {
      setBusy(null);
    }
  }

  function coerceNumber(value: string, fallback: number) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
  }

  function normalizeRatio(value: number | null) {
    if (typeof value !== 'number' || Number.isNaN(value)) return null;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function formatRatio(value: number | null) {
    const normalized = normalizeRatio(value);
    if (typeof normalized !== 'number') return '-';
    return `${(normalized * 100).toFixed(1)}%`;
  }

  type Bucket = { label: string; count: number };

  function renderBuckets(title: string, buckets: Bucket[]) {
    const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
    return (
      <div className="stats-chart">
        <p className="stats-chart-title">{title}</p>
        <div className="stats-chart-rows">
          {buckets.map((bucket) => (
            <div key={bucket.label} className="stats-chart-row">
              <span className="stats-chart-label">{bucket.label}</span>
              <div className="stats-chart-bar">
                <div className="stats-chart-bar-fill" style={{ width: `${(bucket.count / max) * 100}%` }} />
              </div>
              <span className="stats-chart-value">{bucket.count}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const statusById = new Map(subscriptions.map((sub) => [sub.id, sub.status] as const));
  const screenNameById = new Map(subscriptions.map((sub) => [sub.id, sub.screenName] as const));
  const visibleStatsItems = includeUnsubscribedInStats
    ? statsItems
    : statsItems.filter((item) => statusById.get(item.subscriptionId) !== 'UNSUBSCRIBED');

  const scoredUsers = visibleStatsItems.filter((item) => item.scoredTweets > 0);
  const usersWithHighScore = visibleStatsItems.filter((item) => item.highScoreTweets > 0);
  const usersWithHighRatio = scoredUsers.filter((item) => normalizeRatio(item.highScoreRatio) !== null && (item.highScoreRatio ?? 0) >= 0.5);

  const avgImportanceBuckets: Bucket[] = (() => {
    const labels: Bucket[] = [
      { label: '无评分', count: 0 },
      { label: '1.0–1.9', count: 0 },
      { label: '2.0–2.9', count: 0 },
      { label: '3.0–3.9', count: 0 },
      { label: '4.0–4.9', count: 0 },
      { label: '5.0', count: 0 }
    ];
    for (const item of visibleStatsItems) {
      const avg = item.avgImportance;
      if (typeof avg !== 'number' || Number.isNaN(avg)) {
        labels[0].count += 1;
        continue;
      }
      if (avg >= 5) labels[5].count += 1;
      else if (avg >= 4) labels[4].count += 1;
      else if (avg >= 3) labels[3].count += 1;
      else if (avg >= 2) labels[2].count += 1;
      else labels[1].count += 1;
    }
    return labels;
  })();

  const highScoreCountBuckets: Bucket[] = (() => {
    const labels: Bucket[] = [
      { label: '0', count: 0 },
      { label: '1–2', count: 0 },
      { label: '3–5', count: 0 },
      { label: '6–10', count: 0 },
      { label: '11+', count: 0 }
    ];
    for (const item of visibleStatsItems) {
      const count = item.highScoreTweets ?? 0;
      if (count <= 0) labels[0].count += 1;
      else if (count <= 2) labels[1].count += 1;
      else if (count <= 5) labels[2].count += 1;
      else if (count <= 10) labels[3].count += 1;
      else labels[4].count += 1;
    }
    return labels;
  })();

  const highScoreRatioBuckets: Bucket[] = (() => {
    const labels: Bucket[] = [
      { label: '无评分', count: 0 },
      { label: '0–10%', count: 0 },
      { label: '10–25%', count: 0 },
      { label: '25–50%', count: 0 },
      { label: '50–75%', count: 0 },
      { label: '75–100%', count: 0 }
    ];
    for (const item of visibleStatsItems) {
      const ratio = normalizeRatio(item.highScoreRatio);
      if (typeof ratio !== 'number') {
        labels[0].count += 1;
        continue;
      }
      if (ratio < 0.1) labels[1].count += 1;
      else if (ratio < 0.25) labels[2].count += 1;
      else if (ratio < 0.5) labels[3].count += 1;
      else if (ratio < 0.75) labels[4].count += 1;
      else labels[5].count += 1;
    }
    return labels;
  })();

  const topAvgImportance = [...scoredUsers]
    .sort((a, b) => (b.avgImportance ?? 0) - (a.avgImportance ?? 0))
    .slice(0, 10)
    .map((item) => ({
      ...item,
      screenName: screenNameById.get(item.subscriptionId) ?? item.subscriptionId
    }));

  const topHighScoreTweets = [...usersWithHighScore]
    .sort((a, b) => (b.highScoreTweets ?? 0) - (a.highScoreTweets ?? 0))
    .slice(0, 10)
    .map((item) => ({
      ...item,
      screenName: screenNameById.get(item.subscriptionId) ?? item.subscriptionId
    }));

  const autoCandidatesPreview: AutoUnsubscribeCandidate[] = (autoResult?.candidates ?? []).slice(0, 30);

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

        <div className="stats-summary">
          <div className="stats-summary-head">
            <p className="stats-summary-title">统计图表</p>
            <label className="stats-toggle">
              <input
                type="checkbox"
                checked={includeUnsubscribedInStats}
                onChange={(e) => setIncludeUnsubscribedInStats(e.target.checked)}
              />
              <span>包含不再订阅</span>
            </label>
          </div>
          <p className="hint">
            统计口径：均分=importance 平均；高分=importance≥{highScoreMinImportance}；高分占比=高分/有评分推文数。
            当前样本：{visibleStatsItems.length} 人（其中有评分 {scoredUsers.length} 人，高分人数 {usersWithHighScore.length} 人，高分占比≥50% {usersWithHighRatio.length} 人）。
          </p>
          <div className="subscription-form" style={{ marginTop: '0.5rem' }}>
            <input
              type="number"
              step="0.1"
              value={autoRule.minAvgImportance}
              onChange={(e) =>
                setAutoRule((prev) => ({ ...prev, minAvgImportance: coerceNumber(e.target.value, prev.minAvgImportance) }))
              }
              placeholder="均分阈值"
              title="均分阈值（importance 平均）"
            />
            <input
              type="number"
              step="1"
              value={autoRule.minHighScoreTweets}
              onChange={(e) =>
                setAutoRule((prev) => ({
                  ...prev,
                  minHighScoreTweets: Math.max(0, Math.floor(coerceNumber(e.target.value, prev.minHighScoreTweets)))
                }))
              }
              placeholder="高分数量阈值"
              title="高分数量阈值"
            />
            <input
              type="number"
              step="0.01"
              value={autoRule.minHighScoreRatio}
              onChange={(e) =>
                setAutoRule((prev) => ({
                  ...prev,
                  minHighScoreRatio: coerceNumber(e.target.value, prev.minHighScoreRatio)
                }))
              }
              placeholder="高分占比阈值"
              title="高分占比阈值（0-1）"
            />
            <input
              type="number"
              step="1"
              value={autoRule.highScoreMinImportance}
              onChange={(e) =>
                setAutoRule((prev) => ({
                  ...prev,
                  highScoreMinImportance: Math.max(1, Math.floor(coerceNumber(e.target.value, prev.highScoreMinImportance)))
                }))
              }
              placeholder="高分定义"
              title="高分定义（importance≥?）"
            />
            <button onClick={() => handleAutoUnsubscribe(true)} disabled={busy === 'auto-preview' || busy === 'auto-apply'}>
              {busy === 'auto-preview' ? '预览中...' : '预览取消订阅'}
            </button>
            <button
              onClick={() => handleAutoUnsubscribe(false)}
              disabled={busy === 'auto-preview' || busy === 'auto-apply'}
              className="danger"
            >
              {busy === 'auto-apply' ? '执行中...' : '执行取消订阅'}
            </button>
          </div>
          {autoResult && (
            <p className="hint" style={{ marginTop: '0.4rem' }}>
              自动规则结果：评估 {autoResult.evaluated} 人，候选取消 {autoResult.willUnsubscribe} 人，{autoResult.dryRun ? '未写入数据库' : `已更新 ${autoResult.updated} 人`}。
            </p>
          )}
          {autoCandidatesPreview.length > 0 && (
            <pre className="bulk-result" style={{ marginTop: '0.5rem' }}>
              {autoCandidatesPreview
                .map((c, index) => {
                  const avg = typeof c.avgImportance === 'number' ? c.avgImportance.toFixed(2) : '-';
                  const ratio = typeof c.highScoreRatio === 'number' ? `${(c.highScoreRatio * 100).toFixed(1)}%` : '-';
                  return `${index + 1}. @${c.screenName} avg=${avg} scored=${c.scoredTweets} high=${c.highScoreTweets} ratio=${ratio}`;
                })
                .join('\n')}
              {autoResult && autoResult.candidates.length > autoCandidatesPreview.length
                ? `\n... 还有 ${autoResult.candidates.length - autoCandidatesPreview.length} 人未展示`
                : ''}
            </pre>
          )}
          <div className="stats-grid">
            {renderBuckets('博主均分分布', avgImportanceBuckets)}
            {renderBuckets(`高分数量分布（importance≥${highScoreMinImportance}）`, highScoreCountBuckets)}
            {renderBuckets('高分占比分布', highScoreRatioBuckets)}
          </div>
          <div className="stats-top">
            <div className="stats-top-block">
              <p className="stats-chart-title">Top 均分（有评分）</p>
              <ol>
                {topAvgImportance.map((item) => (
                  <li key={item.subscriptionId}>
                    @{item.screenName}：{typeof item.avgImportance === 'number' ? item.avgImportance.toFixed(2) : '-'}（n={item.scoredTweets}，高分占比 {formatRatio(item.highScoreRatio)}）
                  </li>
                ))}
              </ol>
            </div>
            <div className="stats-top-block">
              <p className="stats-chart-title">Top 高分数量</p>
              <ol>
                {topHighScoreTweets.map((item) => (
                  <li key={item.subscriptionId}>
                    @{item.screenName}：{item.highScoreTweets}（高分占比 {formatRatio(item.highScoreRatio)}，有评分 n={item.scoredTweets}）
                  </li>
                ))}
              </ol>
            </div>
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
