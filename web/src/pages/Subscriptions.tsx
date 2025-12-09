import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import type { Subscription } from '../types';

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

  useEffect(() => {
    refreshSubscriptions();
  }, []);

  async function refreshSubscriptions() {
    try {
      const subs = await api.listSubscriptions();
      setSubscriptions(subs);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载订阅失败');
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

  async function handleFetchSubscription(id: string) {
    setBusy(`fetch-${id}`);
    try {
      const result = await api.fetchSubscription(id);
      setStatusMessage(`已抓取 ${result.inserted} 条推文`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '抓取失败');
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
          <h2>订阅列表</h2>
        </div>
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
    </>
  );
}
