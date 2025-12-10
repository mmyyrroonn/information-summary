import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BackgroundJobSummary, BackgroundJobStatus } from '../types';

const typeOptions = [
  { value: '', label: '全部类型' },
  { value: 'fetch-subscriptions', label: '抓取推文' },
  { value: 'classify-tweets', label: 'AI 分类' },
  { value: 'report-pipeline', label: '生成日报' }
] as const;

const statusOptions: { value: '' | BackgroundJobStatus; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'PENDING', label: '排队中' },
  { value: 'RUNNING', label: '执行中' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'FAILED', label: '失败' }
];

export function DevJobsPage() {
  const [jobs, setJobs] = useState<BackgroundJobSummary[]>([]);
  const [filters, setFilters] = useState<{ type: string; status: '' | BackgroundJobStatus }>({
    type: '',
    status: ''
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void refreshJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.type, filters.status]);

  async function refreshJobs() {
    try {
      setLoading(true);
      const response = await api.listJobs({
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        limit: 50
      });
      setJobs(response);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载任务失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(job: BackgroundJobSummary) {
    if (!window.confirm(`确认删除任务 ${job.id.slice(0, 8)}? 此操作不可撤销。`)) {
      return;
    }
    try {
      await api.deleteJob(job.id);
      setJobs((prev) => prev.filter((item) => item.id !== job.id));
      setMessage(`任务 ${job.id.slice(0, 8)} 已删除`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '删除失败');
    }
  }

  return (
    <section>
      <div className="section-head">
        <h2>DEV · 队列管理</h2>
        <button type="button" onClick={refreshJobs} disabled={loading}>
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>
      {message && <p className="status">{message}</p>}
      <div className="jobs-controls">
        <label>
          类型
          <select value={filters.type} onChange={(e) => setFilters((prev) => ({ ...prev, type: e.target.value }))}>
            {typeOptions.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select
            value={filters.status}
            onChange={(e) =>
              setFilters((prev) => ({
                ...prev,
                status: (e.target.value as BackgroundJobStatus | '') ?? ''
              }))
            }
          >
            {statusOptions.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="jobs-table-wrapper">
        <table className="jobs-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>类型</th>
              <th>状态</th>
              <th>尝试次数</th>
              <th>计划时间</th>
              <th>锁定时间</th>
              <th>错误信息</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr>
                <td colSpan={8} className="empty">
                  {loading ? '加载中...' : '暂无任务'}
                </td>
              </tr>
            )}
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.id.slice(0, 8)}</td>
                <td>{renderType(job.type)}</td>
                <td>{renderStatus(job.status)}</td>
                <td>
                  {job.attempts}/{job.maxAttempts}
                </td>
                <td>{formatDate(job.scheduledAt)}</td>
                <td>{job.lockedAt ? formatDate(job.lockedAt) : '-'}</td>
                <td className="jobs-error">{job.lastError ?? '-'}</td>
                <td>
                  <button type="button" className="danger" onClick={() => handleDelete(job)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function renderType(type: string) {
  switch (type) {
    case 'fetch-subscriptions':
      return '抓取推文';
    case 'classify-tweets':
      return 'AI 分类';
    case 'report-pipeline':
      return '日报管线';
    default:
      return type;
  }
}

function renderStatus(status: BackgroundJobStatus) {
  switch (status) {
    case 'PENDING':
      return '排队中';
    case 'RUNNING':
      return '执行中';
    case 'COMPLETED':
      return '已完成';
    case 'FAILED':
      return '失败';
    default:
      return status;
  }
}

function formatDate(input: string | null) {
  if (!input) return '-';
  const date = new Date(input);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}
