import { useEffect, useState } from 'react';
import { api } from '../api';
import type {
  BackgroundJobSummary,
  BackgroundJobStatus,
  ReportProfile,
  ReportProfileGroupBy,
  TagOption,
  TagOptionsResponse
} from '../types';

const typeOptions = [
  { value: '', label: '全部类型' },
  { value: 'fetch-subscriptions', label: '抓取推文' },
  { value: 'classify-tweets', label: 'AI 分类' },
  { value: 'report-pipeline', label: '生成日报' },
  { value: 'report-profile', label: 'Profile 日报' }
] as const;

const statusOptions: { value: '' | BackgroundJobStatus; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'PENDING', label: '排队中' },
  { value: 'RUNNING', label: '执行中' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'FAILED', label: '失败' }
];

const JOB_LIST_LIMIT = 20;
const PROFILE_DEFAULT_TIMEZONE = 'Asia/Shanghai';
const PROFILE_DEFAULT_CRON = '0 9 * * *';

const groupByOptions: { value: ReportProfileGroupBy; label: string }[] = [
  { value: 'cluster', label: '聚类' },
  { value: 'tag', label: '标签' },
  { value: 'author', label: '作者' }
];

const verdictOptions = [
  { value: 'watch', label: '观察' },
  { value: 'actionable', label: '可行动' }
] as const;

const TAG_SUGGESTION_LIMIT = 8;

type ProfileDraft = {
  name: string;
  enabled: boolean;
  scheduleCron: string;
  windowHours: string;
  timezone: string;
  groupBy: ReportProfileGroupBy;
  minImportance: string;
  includeTweetTags: string;
  excludeTweetTags: string;
  includeAuthorTags: string;
  excludeAuthorTags: string;
  verdicts: string[];
  aiFilterEnabled: boolean;
  aiFilterPrompt: string;
  aiFilterMaxKeepPerChunk: string;
};

type ProfileRunOptions = {
  notify: boolean;
  windowEnd: string;
};

function createEmptyDraft(): ProfileDraft {
  return {
    name: '',
    enabled: true,
    scheduleCron: PROFILE_DEFAULT_CRON,
    windowHours: '24',
    timezone: PROFILE_DEFAULT_TIMEZONE,
    groupBy: 'cluster',
    minImportance: '2',
    includeTweetTags: '',
    excludeTweetTags: '',
    includeAuthorTags: '',
    excludeAuthorTags: '',
    verdicts: [],
    aiFilterEnabled: true,
    aiFilterPrompt: '',
    aiFilterMaxKeepPerChunk: ''
  };
}

function parseList(input: string) {
  return input
    .split(/[,，\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => Boolean(entry));
}

function formatList(values?: string[] | null) {
  return values?.length ? values.join(', ') : '';
}

function applyTagSuggestion(value: string, suggestion: string) {
  const parts = value.split(/[,，\n]/);
  if (!parts.length) {
    return suggestion;
  }
  parts[parts.length - 1] = suggestion;
  const seen = new Set<string>();
  const unique: string[] = [];
  parts
    .map((entry) => entry.trim())
    .filter((entry) => Boolean(entry))
    .forEach((entry) => {
      const normalized = entry.toLowerCase();
      if (seen.has(normalized)) return;
      seen.add(normalized);
      unique.push(entry);
    });
  return unique.join(', ');
}

function getTagSuggestions(value: string, options: TagOption[]) {
  const selected = new Set(parseList(value).map((entry) => entry.toLowerCase()));
  const lastToken = value.split(/[,，\n]/).pop()?.trim().toLowerCase() ?? '';
  return options
    .filter((option) => !selected.has(option.tag))
    .filter((option) => (lastToken ? option.tag.includes(lastToken) : true))
    .slice(0, TAG_SUGGESTION_LIMIT);
}

function TagInput({
  label,
  value,
  options,
  placeholder,
  onChange
}: {
  label: string;
  value: string;
  options: TagOption[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const suggestions = getTagSuggestions(value, options);
  return (
    <label className="tag-input">
      {label}
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {options.length ? (
        <div className="tag-suggestions">
          {suggestions.length ? (
            suggestions.map((option) => (
              <button
                key={option.tag}
                type="button"
                className="tag-chip"
                title={`${option.tag} · ${option.count}`}
                onClick={() => onChange(applyTagSuggestion(value, option.tag))}
              >
                {option.tag}
              </button>
            ))
          ) : (
            <span className="tag-empty">无匹配</span>
          )}
        </div>
      ) : null}
    </label>
  );
}

function buildProfilePayload(draft: ProfileDraft) {
  const windowHoursValue = Number(draft.windowHours);
  const minImportance = Number(draft.minImportance);
  const maxKeep = Number(draft.aiFilterMaxKeepPerChunk);
  const timezone = draft.timezone.trim();
  return {
    name: draft.name.trim(),
    enabled: draft.enabled,
    scheduleCron: draft.scheduleCron.trim(),
    windowHours: Number.isFinite(windowHoursValue) && windowHoursValue > 0 ? windowHoursValue : 24,
    ...(timezone ? { timezone } : {}),
    groupBy: draft.groupBy,
    ...(Number.isFinite(minImportance) && minImportance >= 1 && minImportance <= 5 ? { minImportance } : {}),
    includeTweetTags: parseList(draft.includeTweetTags),
    excludeTweetTags: parseList(draft.excludeTweetTags),
    includeAuthorTags: parseList(draft.includeAuthorTags),
    excludeAuthorTags: parseList(draft.excludeAuthorTags),
    verdicts: draft.verdicts,
    aiFilterEnabled: draft.aiFilterEnabled,
    aiFilterPrompt: draft.aiFilterPrompt.trim() ? draft.aiFilterPrompt.trim() : null,
    ...(Number.isFinite(maxKeep) && maxKeep > 0 ? { aiFilterMaxKeepPerChunk: maxKeep } : {})
  };
}

function profileToDraft(profile: ReportProfile): ProfileDraft {
  return {
    name: profile.name,
    enabled: profile.enabled,
    scheduleCron: profile.scheduleCron,
    windowHours: String(profile.windowHours),
    timezone: profile.timezone || PROFILE_DEFAULT_TIMEZONE,
    groupBy: profile.groupBy || 'cluster',
    minImportance: String(profile.minImportance ?? 2),
    includeTweetTags: formatList(profile.includeTweetTags),
    excludeTweetTags: formatList(profile.excludeTweetTags),
    includeAuthorTags: formatList(profile.includeAuthorTags),
    excludeAuthorTags: formatList(profile.excludeAuthorTags),
    verdicts: profile.verdicts ?? [],
    aiFilterEnabled: profile.aiFilterEnabled,
    aiFilterPrompt: profile.aiFilterPrompt ?? '',
    aiFilterMaxKeepPerChunk: profile.aiFilterMaxKeepPerChunk ? String(profile.aiFilterMaxKeepPerChunk) : ''
  };
}

function toggleVerdict(list: string[], value: string) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function DevJobsPage() {
  const [jobs, setJobs] = useState<BackgroundJobSummary[]>([]);
  const [filters, setFilters] = useState<{ type: string; status: '' | BackgroundJobStatus }>({
    type: '',
    status: ''
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState('');
  const [testing, setTesting] = useState(false);
  const [profiles, setProfiles] = useState<ReportProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [tagOptions, setTagOptions] = useState<TagOptionsResponse>({ tweetTags: [], authorTags: [] });
  const [tagOptionsLoading, setTagOptionsLoading] = useState(false);
  const [createDraft, setCreateDraft] = useState<ProfileDraft>(() => createEmptyDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ProfileDraft>(() => createEmptyDraft());
  const [savingProfileId, setSavingProfileId] = useState<string | null>(null);
  const [runningProfileId, setRunningProfileId] = useState<string | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [runOptions, setRunOptions] = useState<Record<string, ProfileRunOptions>>({});

  useEffect(() => {
    void refreshJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.type, filters.status]);

  useEffect(() => {
    void refreshProfiles();
  }, []);

  useEffect(() => {
    void refreshTagOptions();
  }, []);

  async function refreshJobs() {
    try {
      setLoading(true);
      const response = await api.listJobs({
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        limit: JOB_LIST_LIMIT
      });
      setJobs(response);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '加载任务失败');
    } finally {
      setLoading(false);
    }
  }

  async function refreshProfiles() {
    try {
      setProfileMessage(null);
      setProfilesLoading(true);
      const response = await api.listReportProfiles();
      setProfiles(response);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '加载 profile 失败');
    } finally {
      setProfilesLoading(false);
    }
  }

  async function refreshTagOptions() {
    try {
      setTagOptionsLoading(true);
      const response = await api.listTagOptions({ limit: 100 });
      setTagOptions(response);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '加载标签失败');
    } finally {
      setTagOptionsLoading(false);
    }
  }

  async function handleCreateProfile() {
    const payload = buildProfilePayload(createDraft);
    if (!payload.name || !payload.scheduleCron) {
      setProfileMessage('请填写 profile 名称与 cron 表达式');
      return;
    }
    try {
      setProfileMessage(null);
      setSavingProfileId('create');
      await api.createReportProfile(payload);
      setCreateDraft(createEmptyDraft());
      setProfileMessage('Profile 已创建');
      await refreshProfiles();
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '创建 profile 失败');
    } finally {
      setSavingProfileId(null);
    }
  }

  function startEditProfile(profile: ReportProfile) {
    setEditingId(profile.id);
    setEditDraft(profileToDraft(profile));
  }

  async function handleSaveProfile() {
    if (!editingId) return;
    const payload = buildProfilePayload(editDraft);
    if (!payload.name || !payload.scheduleCron) {
      setProfileMessage('请填写 profile 名称与 cron 表达式');
      return;
    }
    try {
      setProfileMessage(null);
      setSavingProfileId(editingId);
      const updated = await api.updateReportProfile(editingId, payload);
      setProfiles((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setProfileMessage('Profile 已更新');
      setEditingId(null);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '更新 profile 失败');
    } finally {
      setSavingProfileId(null);
    }
  }

  async function handleToggleEnabled(profile: ReportProfile) {
    try {
      setProfileMessage(null);
      setSavingProfileId(profile.id);
      const updated = await api.updateReportProfile(profile.id, { enabled: !profile.enabled });
      setProfiles((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setProfileMessage(`Profile ${updated.enabled ? '已启用' : '已停用'}`);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '更新启用状态失败');
    } finally {
      setSavingProfileId(null);
    }
  }

  async function handleRunProfile(profile: ReportProfile) {
    try {
      const options = runOptions[profile.id] ?? { notify: true, windowEnd: '' };
      const windowEnd = options.windowEnd.trim();
      let windowEndIso: string | undefined;
      if (windowEnd) {
        const parsed = new Date(windowEnd);
        if (Number.isNaN(parsed.getTime())) {
          setProfileMessage('窗口结束时间格式不正确');
          return;
        }
        windowEndIso = parsed.toISOString();
      }
      setProfileMessage(null);
      setRunningProfileId(profile.id);
      const result = await api.runReportProfile(profile.id, {
        notify: options.notify,
        ...(windowEndIso ? { windowEnd: windowEndIso } : {})
      });
      setProfileMessage(`Profile 已触发任务 ${result.job.id.slice(0, 8)}`);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '触发 profile 失败');
    } finally {
      setRunningProfileId(null);
    }
  }

  function updateRunOptions(profileId: string, next: Partial<ProfileRunOptions>) {
    setRunOptions((prev) => {
      const current = prev[profileId] ?? { notify: true, windowEnd: '' };
      return { ...prev, [profileId]: { ...current, ...next } };
    });
  }

  async function handleDeleteProfile(profile: ReportProfile) {
    if (!window.confirm(`确认删除 profile ${profile.name}? 此操作不可撤销。`)) {
      return;
    }
    try {
      setProfileMessage(null);
      setDeletingProfileId(profile.id);
      await api.deleteReportProfile(profile.id);
      setProfiles((prev) => prev.filter((item) => item.id !== profile.id));
      setProfileMessage(`Profile ${profile.name} 已删除`);
    } catch (error) {
      setProfileMessage(error instanceof Error ? error.message : '删除 profile 失败');
    } finally {
      setDeletingProfileId(null);
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

  async function handleTestPush() {
    try {
      setTesting(true);
      const trimmed = testMessage.trim();
      const result = await api.sendTelegramTest(trimmed ? { message: trimmed } : {});
      const threadHint = result.messageThreadId ? `，topic ${result.messageThreadId}` : '';
      setMessage(`测试推送成功${threadHint}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '测试推送失败');
    } finally {
      setTesting(false);
    }
  }

  return (
    <section>
      <div className="section-head">
        <h2>DEV · Profile 管理</h2>
        <button type="button" onClick={refreshProfiles} disabled={profilesLoading}>
          {profilesLoading ? '刷新中...' : '刷新'}
        </button>
      </div>
      {profileMessage && <p className="status">{profileMessage}</p>}
      <div className="dev-profiles">
        <div className="profile-card">
          <div className="profile-row-head">
            <div>
              <h3>新建 Profile</h3>
              <p className="hint">使用 cron 定时 + 窗口小时数生成多维日报。</p>
            </div>
            <label className="notify-toggle">
              <input
                type="checkbox"
                checked={createDraft.enabled}
                onChange={(e) => setCreateDraft((prev) => ({ ...prev, enabled: e.target.checked }))}
              />
              启用
            </label>
          </div>
          <div className="profile-form">
            <label>
              名称
              <input
                value={createDraft.name}
                onChange={(e) => setCreateDraft((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="例如：宏观日报"
              />
            </label>
            <label>
              Cron 表达式
              <input
                value={createDraft.scheduleCron}
                onChange={(e) => setCreateDraft((prev) => ({ ...prev, scheduleCron: e.target.value }))}
                placeholder="0 9 * * *"
              />
            </label>
            <label>
              窗口小时数
              <input
                type="number"
                value={createDraft.windowHours}
                onChange={(e) => setCreateDraft((prev) => ({ ...prev, windowHours: e.target.value }))}
              />
            </label>
            <label>
              时区
              <input
                value={createDraft.timezone}
                onChange={(e) => setCreateDraft((prev) => ({ ...prev, timezone: e.target.value }))}
                placeholder="Asia/Shanghai"
              />
            </label>
            <label>
              分组方式
              <select
                value={createDraft.groupBy}
                onChange={(e) =>
                  setCreateDraft((prev) => ({ ...prev, groupBy: e.target.value as ReportProfileGroupBy }))
                }
              >
                {groupByOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              最低重要度
              <input
                type="number"
                value={createDraft.minImportance}
                onChange={(e) => setCreateDraft((prev) => ({ ...prev, minImportance: e.target.value }))}
              />
            </label>
            <TagInput
              label="推文标签（包含）"
              value={createDraft.includeTweetTags}
              options={tagOptions.tweetTags}
              placeholder={tagOptionsLoading ? '标签加载中...' : '用逗号分隔标签'}
              onChange={(value) => setCreateDraft((prev) => ({ ...prev, includeTweetTags: value }))}
            />
            <TagInput
              label="推文标签（排除）"
              value={createDraft.excludeTweetTags}
              options={tagOptions.tweetTags}
              placeholder={tagOptionsLoading ? '标签加载中...' : '用逗号分隔标签'}
              onChange={(value) => setCreateDraft((prev) => ({ ...prev, excludeTweetTags: value }))}
            />
            <TagInput
              label="作者标签（包含）"
              value={createDraft.includeAuthorTags}
              options={tagOptions.authorTags}
              placeholder={tagOptionsLoading ? '标签加载中...' : '用逗号分隔标签'}
              onChange={(value) => setCreateDraft((prev) => ({ ...prev, includeAuthorTags: value }))}
            />
            <TagInput
              label="作者标签（排除）"
              value={createDraft.excludeAuthorTags}
              options={tagOptions.authorTags}
              placeholder={tagOptionsLoading ? '标签加载中...' : '用逗号分隔标签'}
              onChange={(value) => setCreateDraft((prev) => ({ ...prev, excludeAuthorTags: value }))}
            />
            <label>
              Verdict 过滤
              <div className="profile-checklist">
                {verdictOptions.map((option) => (
                  <label key={option.value}>
                    <input
                      type="checkbox"
                      checked={createDraft.verdicts.includes(option.value)}
                      onChange={() =>
                        setCreateDraft((prev) => ({ ...prev, verdicts: toggleVerdict(prev.verdicts, option.value) }))
                      }
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </label>
            <label>
              AI 二次筛选
              <select
                value={createDraft.aiFilterEnabled ? 'yes' : 'no'}
                onChange={(e) =>
                  setCreateDraft((prev) => ({ ...prev, aiFilterEnabled: e.target.value === 'yes' }))
                }
              >
                <option value="yes">启用</option>
                <option value="no">关闭</option>
              </select>
            </label>
            <label>
              每批保留上限
              <input
                type="number"
                value={createDraft.aiFilterMaxKeepPerChunk}
                onChange={(e) => setCreateDraft((prev) => ({ ...prev, aiFilterMaxKeepPerChunk: e.target.value }))}
                placeholder="15"
              />
            </label>
            <label className="profile-form-full">
              AI 过滤提示
              <textarea
                value={createDraft.aiFilterPrompt}
                onChange={(e) => setCreateDraft((prev) => ({ ...prev, aiFilterPrompt: e.target.value }))}
                placeholder="例如：优先保留宏观政策、监管、利率等信号"
              />
            </label>
          </div>
          <div className="profile-actions">
            <button type="button" onClick={handleCreateProfile} disabled={savingProfileId === 'create'}>
              {savingProfileId === 'create' ? '创建中...' : '创建 Profile'}
            </button>
          </div>
        </div>

        <div className="profile-list">
          {profiles.length === 0 && <p className="empty">暂无 profile</p>}
          {profiles.map((profile) => {
            const isEditing = editingId === profile.id;
            return (
              <div className="profile-row" key={profile.id}>
                <div className="profile-row-head">
                  <div>
                    <h3>{profile.name}</h3>
                    <p className="hint">
                      {profile.enabled ? '启用中' : '已停用'} · {profile.scheduleCron} · {profile.windowHours}h ·{' '}
                      {profile.timezone}
                    </p>
                  </div>
                  <div className="profile-actions">
                    <button
                      type="button"
                      onClick={() => handleToggleEnabled(profile)}
                      disabled={savingProfileId === profile.id}
                    >
                      {profile.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => (isEditing ? setEditingId(null) : startEditProfile(profile))}
                    >
                      {isEditing ? '收起编辑' : '编辑'}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => handleDeleteProfile(profile)}
                      disabled={deletingProfileId === profile.id}
                    >
                      删除
                    </button>
                  </div>
                </div>
                <div className="profile-meta">
                  <span>分组：{groupByOptions.find((item) => item.value === profile.groupBy)?.label ?? profile.groupBy}</span>
                  <span>最低重要度：{profile.minImportance}</span>
                  <span>推文标签：{formatList(profile.includeTweetTags) || '不限'}</span>
                  <span>作者标签：{formatList(profile.includeAuthorTags) || '不限'}</span>
                  <span>AI 二次筛选：{profile.aiFilterEnabled ? '启用' : '关闭'}</span>
                </div>
                <div className="profile-runner">
                  <label className="notify-toggle">
                    <input
                      type="checkbox"
                      checked={(runOptions[profile.id] ?? { notify: true, windowEnd: '' }).notify}
                      onChange={(e) => updateRunOptions(profile.id, { notify: e.target.checked })}
                    />
                    执行后推送
                  </label>
                  <label>
                    窗口结束时间
                    <input
                      type="datetime-local"
                      value={(runOptions[profile.id] ?? { notify: true, windowEnd: '' }).windowEnd}
                      onChange={(e) => updateRunOptions(profile.id, { windowEnd: e.target.value })}
                    />
                    <span className="hint">留空则使用当前时间</span>
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => handleRunProfile(profile)}
                    disabled={runningProfileId === profile.id}
                  >
                    {runningProfileId === profile.id ? '触发中...' : '立即执行'}
                  </button>
                </div>

                {isEditing && (
                  <div className="profile-edit">
                    <div className="profile-form">
                      <label>
                        名称
                        <input
                          value={editDraft.name}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, name: e.target.value }))}
                        />
                      </label>
                      <label>
                        Cron 表达式
                        <input
                          value={editDraft.scheduleCron}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, scheduleCron: e.target.value }))}
                        />
                      </label>
                      <label>
                        窗口小时数
                        <input
                          type="number"
                          value={editDraft.windowHours}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, windowHours: e.target.value }))}
                        />
                      </label>
                      <label>
                        时区
                        <input
                          value={editDraft.timezone}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, timezone: e.target.value }))}
                        />
                      </label>
                      <label>
                        分组方式
                        <select
                          value={editDraft.groupBy}
                          onChange={(e) =>
                            setEditDraft((prev) => ({ ...prev, groupBy: e.target.value as ReportProfileGroupBy }))
                          }
                        >
                          {groupByOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        最低重要度
                        <input
                          type="number"
                          value={editDraft.minImportance}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, minImportance: e.target.value }))}
                        />
                      </label>
                      <TagInput
                        label="推文标签（包含）"
                        value={editDraft.includeTweetTags}
                        options={tagOptions.tweetTags}
                        placeholder={tagOptionsLoading ? '标签加载中...' : '用逗号分隔标签'}
                        onChange={(value) => setEditDraft((prev) => ({ ...prev, includeTweetTags: value }))}
                      />
                      <TagInput
                        label="推文标签（排除）"
                        value={editDraft.excludeTweetTags}
                        options={tagOptions.tweetTags}
                        placeholder={tagOptionsLoading ? '标签加载中...' : '用逗号分隔标签'}
                        onChange={(value) => setEditDraft((prev) => ({ ...prev, excludeTweetTags: value }))}
                      />
                      <TagInput
                        label="作者标签（包含）"
                        value={editDraft.includeAuthorTags}
                        options={tagOptions.authorTags}
                        placeholder={tagOptionsLoading ? '标签加载中...' : '用逗号分隔标签'}
                        onChange={(value) => setEditDraft((prev) => ({ ...prev, includeAuthorTags: value }))}
                      />
                      <TagInput
                        label="作者标签（排除）"
                        value={editDraft.excludeAuthorTags}
                        options={tagOptions.authorTags}
                        placeholder={tagOptionsLoading ? '标签加载中...' : '用逗号分隔标签'}
                        onChange={(value) => setEditDraft((prev) => ({ ...prev, excludeAuthorTags: value }))}
                      />
                      <label>
                        Verdict 过滤
                        <div className="profile-checklist">
                          {verdictOptions.map((option) => (
                            <label key={option.value}>
                              <input
                                type="checkbox"
                                checked={editDraft.verdicts.includes(option.value)}
                                onChange={() =>
                                  setEditDraft((prev) => ({
                                    ...prev,
                                    verdicts: toggleVerdict(prev.verdicts, option.value)
                                  }))
                                }
                              />
                              {option.label}
                            </label>
                          ))}
                        </div>
                      </label>
                      <label>
                        AI 二次筛选
                        <select
                          value={editDraft.aiFilterEnabled ? 'yes' : 'no'}
                          onChange={(e) =>
                            setEditDraft((prev) => ({ ...prev, aiFilterEnabled: e.target.value === 'yes' }))
                          }
                        >
                          <option value="yes">启用</option>
                          <option value="no">关闭</option>
                        </select>
                      </label>
                      <label>
                        每批保留上限
                        <input
                          type="number"
                          value={editDraft.aiFilterMaxKeepPerChunk}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, aiFilterMaxKeepPerChunk: e.target.value }))}
                        />
                      </label>
                      <label className="profile-form-full">
                        AI 过滤提示
                        <textarea
                          value={editDraft.aiFilterPrompt}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, aiFilterPrompt: e.target.value }))}
                        />
                      </label>
                      <label className="notify-toggle">
                        <input
                          type="checkbox"
                          checked={editDraft.enabled}
                          onChange={(e) => setEditDraft((prev) => ({ ...prev, enabled: e.target.checked }))}
                        />
                        启用
                      </label>
                    </div>
                    <div className="profile-actions">
                      <button type="button" onClick={handleSaveProfile} disabled={savingProfileId === profile.id}>
                        {savingProfileId === profile.id ? '保存中...' : '保存'}
                      </button>
                      <button type="button" className="ghost" onClick={() => setEditingId(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="dev-divider" />

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
      <div className="dev-notify">
        <h3>Telegram 测试推送</h3>
        <p className="hint">使用当前配置的 TG_CHAT_ID / TG_MESSAGE_THREAD_ID</p>
        <div className="config-grid">
          <label>
            内容
            <input
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              placeholder="可留空，默认生成测试文案"
            />
          </label>
          <button type="button" onClick={handleTestPush} disabled={testing}>
            {testing ? '推送中...' : '发送测试消息'}
          </button>
        </div>
        <p className="hint">任务列表仅展示最近 {JOB_LIST_LIMIT} 条。</p>
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
    case 'report-profile':
      return 'Profile 日报';
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
