import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { api } from '../api';
import type { BackgroundJobSummary, ReportDetail, ReportSummary, SocialDigestResult, SocialImagePromptResult } from '../types';

marked.setOptions({
  gfm: true,
  breaks: true
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer noopener');
  }
});

type ClusteredReportOutline = {
  mode: 'clustered';
  totalInsights: number;
  rawInsights?: number;
  triage?: {
    enabled: boolean;
    highKept: number;
    midCandidates: number;
    midKept: number;
  };
  totalClusters: number;
  shownClusters: number;
  sections: Array<{
    tag: string;
    title: string;
    clusters: Array<{
      id: string;
      size: number;
      peakImportance: number;
      tags: string[];
      representative: {
        tweetId: string;
        tweetUrl: string;
        summary: string;
        importance: number;
        verdict: string;
        suggestions?: string | null;
      };
      memberTweetIds: string[];
    }>;
  }>;
};

type ReportOutlinePayload = {
  sections?: Array<{
    items?: Array<{
      tags?: string[] | null;
    }>;
  }>;
};

function asClusteredOutline(value: unknown): ClusteredReportOutline | null {
  if (!value || typeof value !== 'object') return null;
  const mode = (value as Record<string, unknown>).mode;
  if (mode !== 'clustered') return null;
  const sections = (value as Record<string, unknown>).sections;
  if (!Array.isArray(sections)) return null;
  return value as ClusteredReportOutline;
}

function extractOutlineTags(outline: unknown) {
  const tags = new Set<string>();
  const clustered = asClusteredOutline(outline);
  if (clustered) {
    clustered.sections.forEach((section) => {
      if (section.tag) {
        tags.add(section.tag);
      }
      section.clusters.forEach((cluster) => {
        cluster.tags?.forEach((tag) => tags.add(tag));
      });
    });
  } else if (outline && typeof outline === 'object') {
    const sections = (outline as ReportOutlinePayload).sections;
    if (Array.isArray(sections)) {
      sections.forEach((section) => {
        if (!Array.isArray(section.items)) return;
        section.items.forEach((item) => {
          if (!Array.isArray(item.tags)) return;
          item.tags.forEach((tag) => tags.add(tag));
        });
      });
    }
  }
  return [...tags].map((tag) => tag.trim()).filter(Boolean).sort();
}

function tweetLink(id: string) {
  return `https://x.com/i/web/status/${id}`;
}

export function DashboardPage() {
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [selectedReport, setSelectedReport] = useState<ReportDetail | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [statusLink, setStatusLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [socialDigest, setSocialDigest] = useState<SocialDigestResult | null>(null);
  const [socialPrompt, setSocialPrompt] = useState('');
  const [socialStatus, setSocialStatus] = useState<string | null>(null);
  const [socialBusy, setSocialBusy] = useState(false);
  const [socialJob, setSocialJob] = useState<BackgroundJobSummary | null>(null);
  const [socialIncludeText, setSocialIncludeText] = useState(false);
  const [socialTags, setSocialTags] = useState<string[]>([]);
  const [socialProvider, setSocialProvider] = useState<'deepseek' | 'dashscope'>('dashscope');
  const [imagePrompt, setImagePrompt] = useState<SocialImagePromptResult | null>(null);
  const [imagePromptJob, setImagePromptJob] = useState<BackgroundJobSummary | null>(null);
  const [imagePromptExtra, setImagePromptExtra] = useState('');
  const [imagePromptStatus, setImagePromptStatus] = useState<string | null>(null);
  const [imagePromptBusy, setImagePromptBusy] = useState(false);
  const [imagePromptProvider, setImagePromptProvider] = useState<'deepseek' | 'dashscope'>('dashscope');
  const [sharedMaxItems, setSharedMaxItems] = useState(8);
  const bundleNextImageRef = useRef(false);
  const socialPollerRef = useRef<number | null>(null);
  const imagePromptPollerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);
  const reportHtml = useMemo(() => {
    if (!selectedReport?.content) {
      return '';
    }
    const withLinks = linkifyTweetIds(selectedReport.content);
    const parsed = marked.parse(withLinks);
    const rawHtml = typeof parsed === 'string' ? parsed : '';
    return DOMPurify.sanitize(rawHtml);
  }, [selectedReport?.content]);

  const clusteredOutline = useMemo(() => asClusteredOutline(selectedReport?.outline), [selectedReport?.outline]);
  const reportTags = useMemo(() => extractOutlineTags(selectedReport?.outline), [selectedReport?.outline]);

  useEffect(() => {
    if (!reportTags.length) {
      setSocialTags([]);
      return;
    }
    setSocialTags((prev) => prev.filter((tag) => reportTags.includes(tag)));
  }, [reportTags]);

  useEffect(() => {
    aliveRef.current = true;
    refreshReports();
    return () => {
      aliveRef.current = false;
      stopSocialPolling();
      stopImagePromptPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshReports() {
    try {
      const reportsList = await api.listReports();
      setReports(reportsList);
      if (reportsList.length) {
        await loadReport(reportsList[0].id);
      } else {
        setSelectedReport(null);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '加载日报失败');
      setStatusLink(null);
    }
  }

  async function loadReport(id: string) {
    try {
      const data = await api.getReport(id);
      setSelectedReport(data);
      setSocialDigest(null);
      setSocialStatus(null);
      setSocialJob(null);
      setImagePrompt(null);
      setImagePromptStatus(null);
      setImagePromptJob(null);
      stopSocialPolling();
      stopImagePromptPolling();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '读取日报失败');
      setStatusLink(null);
    }
  }

  async function handleSendReport(id: string) {
    setBusy(`send-${id}`);
    try {
      await api.sendReport(id);
      setStatusMessage('推送成功');
      setStatusLink(null);
      await refreshReports();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '推送失败');
      setStatusLink(null);
    } finally {
      setBusy(null);
    }
  }

  async function handleSendHighScoreReport(id: string) {
    setBusy(`send-high-${id}`);
    try {
      await api.sendHighScoreReport(id);
      setStatusMessage('高分推送成功');
      setStatusLink(null);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '高分推送失败');
      setStatusLink(null);
    } finally {
      setBusy(null);
    }
  }

  async function handlePublishReport(id: string) {
    setBusy(`publish-${id}`);
    try {
      const result = await api.publishReport(id);
      const link = result.url || result.indexUrl || null;
      setStatusMessage(link ? 'GitHub 发布成功' : 'GitHub 发布成功（未配置链接）');
      setStatusLink(link);
      await refreshReports();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'GitHub 发布失败');
      setStatusLink(null);
    } finally {
      setBusy(null);
    }
  }

  function stopSocialPolling() {
    if (socialPollerRef.current) {
      window.clearTimeout(socialPollerRef.current);
      socialPollerRef.current = null;
    }
  }

  function stopImagePromptPolling() {
    if (imagePromptPollerRef.current) {
      window.clearTimeout(imagePromptPollerRef.current);
      imagePromptPollerRef.current = null;
    }
  }

  function extractSocialResult(job: BackgroundJobSummary): SocialDigestResult | null {
    const payload = job.payload as {
      result?: SocialDigestResult;
    } | null;
    if (!payload || typeof payload !== 'object') return null;
    const result = payload.result;
    if (!result || typeof result !== 'object') return null;
    if (typeof result.content !== 'string') return null;
    const bullets = Array.isArray(result.bullets)
      ? result.bullets.filter((item) => typeof item === 'string')
      : [];
    return {
      ...result,
      bullets
    };
  }

  function extractImagePromptResult(job: BackgroundJobSummary): SocialImagePromptResult | null {
    const payload = job.payload as {
      result?: SocialImagePromptResult;
    } | null;
    if (!payload || typeof payload !== 'object') return null;
    const result = payload.result;
    if (!result || typeof result !== 'object') return null;
    if (typeof result.prompt !== 'string') return null;
    return result;
  }

  function formatJobStatus(job?: BackgroundJobSummary | null) {
    if (!job) return null;
    if (job.status === 'PENDING') return '排队中...';
    if (job.status === 'RUNNING') return '生成中...';
    if (job.status === 'COMPLETED') return '生成完成';
    if (job.status === 'FAILED') {
      return job.lastError ? `失败：${job.lastError}` : '生成失败';
    }
    return null;
  }

  async function runImagePromptFromDigest(digest: string) {
    if (!selectedReport) return;
    stopImagePromptPolling();
    setImagePromptBusy(true);
    setImagePromptStatus(null);
    setImagePrompt(null);
    setImagePromptJob(null);
    try {
      const response = await api.generateSocialImagePrompt(selectedReport.id, {
        ...(imagePromptExtra.trim() ? { prompt: imagePromptExtra.trim() } : {}),
        ...(typeof sharedMaxItems === 'number' ? { maxItems: sharedMaxItems } : {}),
        provider: imagePromptProvider,
        digest
      });
      setImagePromptJob(response.job);
      setImagePromptStatus('已加入队列');
      startImagePromptPolling(response.job.id);
    } catch (error) {
      setImagePromptStatus(error instanceof Error ? error.message : '图片 Prompt 生成失败');
      setImagePromptBusy(false);
      stopImagePromptPolling();
    } finally {
      // busy 状态由轮询结束时关闭
    }
  }

  function startSocialPolling(jobId: string) {
    stopSocialPolling();
    const poll = async () => {
      try {
        const job = await api.getJob(jobId);
        if (!aliveRef.current) return;
        setSocialJob(job);
        setSocialStatus(formatJobStatus(job));
        if (job.status === 'COMPLETED') {
          const result = extractSocialResult(job);
          if (result) {
            setSocialDigest(result);
          } else {
            setSocialStatus('任务完成但未返回内容');
          }
          setSocialBusy(false);
          stopSocialPolling();
          if (bundleNextImageRef.current) {
            bundleNextImageRef.current = false;
            if (result?.content) {
              const digestPayload =
                result.bullets.length > 0
                  ? JSON.stringify({ content: result.content, bullets: result.bullets }, null, 2)
                  : result.content;
              void runImagePromptFromDigest(digestPayload);
            } else {
              setImagePromptStatus('社媒文案为空，无法生成图片 Prompt');
            }
          }
          return;
        }
        if (job.status === 'FAILED') {
          setSocialBusy(false);
          stopSocialPolling();
          if (bundleNextImageRef.current) {
            bundleNextImageRef.current = false;
            setImagePromptStatus('社媒文案生成失败，无法生成图片 Prompt');
          }
          return;
        }
        socialPollerRef.current = window.setTimeout(poll, 3000);
      } catch (error) {
        if (!aliveRef.current) return;
        setSocialStatus(error instanceof Error ? error.message : '任务状态查询失败');
        setSocialBusy(false);
        stopSocialPolling();
        if (bundleNextImageRef.current) {
          bundleNextImageRef.current = false;
          setImagePromptStatus('社媒文案生成异常，无法生成图片 Prompt');
        }
      }
    };
    void poll();
  }

  function startImagePromptPolling(jobId: string) {
    stopImagePromptPolling();
    const poll = async () => {
      try {
        const job = await api.getJob(jobId);
        if (!aliveRef.current) return;
        setImagePromptJob(job);
        setImagePromptStatus(formatJobStatus(job));
        if (job.status === 'COMPLETED') {
          const result = extractImagePromptResult(job);
          if (result) {
            setImagePrompt(result);
          } else {
            setImagePromptStatus('任务完成但未返回内容');
          }
          setImagePromptBusy(false);
          stopImagePromptPolling();
          return;
        }
        if (job.status === 'FAILED') {
          setImagePromptBusy(false);
          stopImagePromptPolling();
          return;
        }
        imagePromptPollerRef.current = window.setTimeout(poll, 3000);
      } catch (error) {
        if (!aliveRef.current) return;
        setImagePromptStatus(error instanceof Error ? error.message : '任务状态查询失败');
        setImagePromptBusy(false);
        stopImagePromptPolling();
      }
    };
    void poll();
  }

  async function generateSocialDigest(chainImage: boolean) {
    if (!selectedReport) return;
    stopSocialPolling();
    setSocialJob(null);
    setSocialBusy(true);
    setSocialStatus(null);
    if (chainImage) {
      bundleNextImageRef.current = true;
      setImagePromptStatus('等待社媒文案完成...');
      setImagePrompt(null);
      setImagePromptJob(null);
      stopImagePromptPolling();
    } else {
      bundleNextImageRef.current = false;
    }
    try {
      const response = await api.generateSocialDigest(selectedReport.id, {
        ...(socialPrompt.trim() ? { prompt: socialPrompt.trim() } : {}),
        ...(typeof sharedMaxItems === 'number' ? { maxItems: sharedMaxItems } : {}),
        ...(socialIncludeText ? { includeTweetText: true } : {}),
        ...(socialTags.length ? { tags: socialTags } : {}),
        provider: socialProvider
      });
      setSocialDigest(null);
      setSocialJob(response.job);
      setSocialStatus('已加入队列');
      startSocialPolling(response.job.id);
    } catch (error) {
      setSocialStatus(error instanceof Error ? error.message : '社媒文案生成失败');
      setSocialBusy(false);
      if (bundleNextImageRef.current) {
        bundleNextImageRef.current = false;
        setImagePromptStatus('社媒文案生成失败，无法生成图片 Prompt');
      }
    }
  }

  function handleGenerateSocialDigest() {
    void generateSocialDigest(false);
  }

  async function handleCopySocialDigest() {
    if (!socialDigest?.content) return;
    try {
      await navigator.clipboard.writeText(socialDigest.content);
      setSocialStatus('已复制到剪贴板');
    } catch (error) {
      setSocialStatus(error instanceof Error ? error.message : '复制失败');
    }
  }

  function toggleSocialTag(tag: string) {
    setSocialTags((prev) => {
      if (prev.includes(tag)) {
        return prev.filter((entry) => entry !== tag);
      }
      return [...prev, tag];
    });
  }

  function handleDownloadSocialDigest() {
    if (!socialDigest?.content) return;
    const blob = new Blob([socialDigest.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `social-digest-${selectedReport?.id ?? 'report'}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleGenerateImagePrompt() {
    if (!selectedReport) return;
    if (!socialDigest?.content) {
      setImagePromptStatus('请先生成社媒文案，图片 Prompt 将基于该文案生成');
      return;
    }
    await runImagePromptFromDigest(socialDigest.content);
  }

  function handleGenerateSocialBundle() {
    void generateSocialDigest(true);
  }

  async function handleCopyImagePrompt() {
    if (!imagePrompt?.prompt) return;
    try {
      await navigator.clipboard.writeText(imagePrompt.prompt);
      setImagePromptStatus('已复制到剪贴板');
    } catch (error) {
      setImagePromptStatus(error instanceof Error ? error.message : '复制失败');
    }
  }

  function handleDownloadImagePrompt() {
    if (!imagePrompt?.prompt) return;
    const blob = new Blob([imagePrompt.prompt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `social-image-prompt-${selectedReport?.id ?? 'report'}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      {statusMessage && (
        <p className="status">
          {statusMessage}
          {statusLink ? (
            <>
              {' '}
              <a href={statusLink} target="_blank" rel="noreferrer">
                打开
              </a>
            </>
          ) : null}
        </p>
      )}
      <section>
        <div className="section-head">
          <h2>日报记录</h2>
          <button onClick={refreshReports}>刷新列表</button>
        </div>
        <div className="reports-panel">
          <div className="reports-list">
            {reports.length === 0 && <p className="empty">暂无日报</p>}
            {reports.map((report) => (
              <div
                key={report.id}
                className={`report-row ${selectedReport?.id === report.id ? 'active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => loadReport(report.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') loadReport(report.id);
                }}
              >
                <div className="report-info">
                  <p className="title">{report.headline}</p>
                  <p className="meta">
                    {new Date(report.periodStart).toLocaleDateString()} - {new Date(report.periodEnd).toLocaleDateString()}
                  </p>
                  <div className="report-actions">
                    <button
                      className="ghost"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSendReport(report.id);
                      }}
                      disabled={busy === `send-${report.id}`}
                    >
                      推送TG
                    </button>
                    <button
                      className="ghost"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSendHighScoreReport(report.id);
                      }}
                      disabled={busy === `send-high-${report.id}`}
                    >
                      推送高分
                    </button>
                    <button
                      className="ghost"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePublishReport(report.id);
                      }}
                      disabled={busy === `publish-${report.id}`}
                    >
                      推送 GitHub
                    </button>
                  </div>
                  <div className="report-status">
                    <span>Telegram: {report.deliveredAt ? '已推送' : '未推送'}</span>
                    <span>GitHub: {report.publishedAt ? '已发布' : '未发布'}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <article className="report-view">
            {selectedReport ? (
              <>
                <h3>{selectedReport.headline}</h3>
                {reportHtml ? (
                  <div className="markdown-body" dangerouslySetInnerHTML={{ __html: reportHtml }} />
                ) : (
                  <p className="empty">报告内容为空</p>
                )}
                {clusteredOutline ? (
                  <details className="cluster-debug">
                    <summary>
                      聚类明细（展示 {clusteredOutline.shownClusters} / 总计 {clusteredOutline.totalClusters}，候选{' '}
                      {clusteredOutline.totalInsights}
                      {clusteredOutline.triage?.enabled &&
                      typeof clusteredOutline.rawInsights === 'number' &&
                      clusteredOutline.rawInsights !== clusteredOutline.totalInsights
                        ? `；原始 ${clusteredOutline.rawInsights}，4-5⭐ ${clusteredOutline.triage.highKept}，2-3⭐ ${clusteredOutline.triage.midCandidates}→${clusteredOutline.triage.midKept}`
                        : ''}
                      ）
                    </summary>
                    <div className="cluster-debug-body">
                      {clusteredOutline.sections.map((section) => (
                        <details key={section.tag} className="cluster-tag">
                          <summary>
                            {section.title}（{section.clusters.length}）
                          </summary>
                          <div className="cluster-tag-body">
                            {section.clusters.map((cluster) => (
                              <details key={cluster.id} className="cluster-item">
                                <summary>
                                  #{cluster.id}（{cluster.size}条 / 最高{cluster.peakImportance}⭐）：{cluster.representative.summary}
                                </summary>
                                <div className="cluster-item-body">
                                  <p className="muted">
                                    代表推文：{' '}
                                    <a href={cluster.representative.tweetUrl || tweetLink(cluster.representative.tweetId)} target="_blank" rel="noreferrer">
                                      {cluster.representative.tweetId}
                                    </a>
                                  </p>
                                  <div className="cluster-member-list">
                                    {cluster.memberTweetIds.map((tweetId) => (
                                      <a key={tweetId} href={tweetLink(tweetId)} target="_blank" rel="noreferrer" className="cluster-member">
                                        {tweetId}
                                      </a>
                                    ))}
                                  </div>
                                </div>
                              </details>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="empty">选择左侧的日报查看详情</p>
            )}
            {selectedReport ? (
              <>
              <div className="social-digest">
                <div className="social-digest-head">
                  <h3>社媒文案</h3>
                  <div className="social-digest-actions">
                    <button type="button" className="ghost" onClick={handleGenerateSocialBundle} disabled={socialBusy || imagePromptBusy}>
                      一键生成
                    </button>
                    <button type="button" onClick={handleGenerateSocialDigest} disabled={socialBusy}>
                      {socialBusy ? '生成中...' : '生成'}
                    </button>
                    <button type="button" className="ghost" onClick={handleCopySocialDigest} disabled={!socialDigest?.content}>
                      复制
                    </button>
                    <button type="button" className="ghost" onClick={handleDownloadSocialDigest} disabled={!socialDigest?.content}>
                      下载
                    </button>
                  </div>
                </div>
                <label className="social-digest-label">
                  额外要求（可选）
                  <textarea
                    value={socialPrompt}
                    onChange={(event) => setSocialPrompt(event.target.value)}
                    rows={3}
                    placeholder="比如：多一点口语化、强调市场情绪、不要提某主题..."
                  />
                </label>
                <label className="social-digest-label">
                  生成引擎
                  <select value={socialProvider} onChange={(event) => setSocialProvider(event.target.value as 'deepseek' | 'dashscope')}>
                    <option value="deepseek">DeepSeek（deepseek-chat）</option>
                    <option value="dashscope">Qwen（qwen3-max）</option>
                  </select>
                </label>
                <label className="social-digest-label">
                  要点数量（社媒文案）
                  <select
                    value={sharedMaxItems}
                    onChange={(event) => setSharedMaxItems(Number(event.target.value))}
                  >
                    <option value={5}>5</option>
                    <option value={6}>6</option>
                    <option value={8}>8</option>
                    <option value={10}>10</option>
                    <option value={12}>12</option>
                  </select>
                </label>
                {reportTags.length ? (
                  <div className="social-digest-label">
                    <span>选择标签（可选）</span>
                    <div className="social-digest-tags">
                      {reportTags.map((tag) => (
                        <label
                          key={tag}
                          className={`social-digest-tag${socialTags.includes(tag) ? ' active' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={socialTags.includes(tag)}
                            onChange={() => toggleSocialTag(tag)}
                          />
                          {tag}
                        </label>
                      ))}
                    </div>
                    <span className="social-digest-hint">未选择则使用全部素材；多选会分别生成多条。</span>
                  </div>
                ) : null}
                <label className="social-digest-toggle">
                  <input
                    type="checkbox"
                    checked={socialIncludeText}
                    onChange={(event) => setSocialIncludeText(event.target.checked)}
                  />
                  附带原文片段（调试用）
                </label>
                {socialStatus ? <p className="status">{socialStatus}</p> : null}
                {socialJob ? <p className="meta">任务ID：{socialJob.id}</p> : null}
                {socialDigest?.content ? (
                  <pre className="social-digest-output">{socialDigest.content}</pre>
                ) : (
                  <p className="empty">点击生成，使用当前日报作为素材。</p>
                )}
                {socialDigest ? (
                  <p className="meta">
                    素材 {socialDigest.usedItems}/{socialDigest.totalItems} 条 · 时间范围{' '}
                    {new Date(socialDigest.periodStart).toLocaleString()} - {new Date(socialDigest.periodEnd).toLocaleString()}
                  </p>
                ) : null}
              </div>
              <div className="social-digest">
                <div className="social-digest-head">
                  <h3>图片 Prompt（nano banana）</h3>
                  <div className="social-digest-actions">
                    <button type="button" onClick={handleGenerateImagePrompt} disabled={imagePromptBusy}>
                      {imagePromptBusy ? '生成中...' : '生成'}
                    </button>
                    <button type="button" className="ghost" onClick={handleCopyImagePrompt} disabled={!imagePrompt?.prompt}>
                      复制
                    </button>
                    <button type="button" className="ghost" onClick={handleDownloadImagePrompt} disabled={!imagePrompt?.prompt}>
                      下载
                    </button>
                  </div>
                </div>
                <label className="social-digest-label">
                  额外偏好（可选）
                  <textarea
                    value={imagePromptExtra}
                    onChange={(event) => setImagePromptExtra(event.target.value)}
                    rows={3}
                    placeholder="比如：更极简、更多留白、强调数据感..."
                  />
                </label>
                <label className="social-digest-label">
                  生成引擎
                  <select
                    value={imagePromptProvider}
                    onChange={(event) => setImagePromptProvider(event.target.value as 'deepseek' | 'dashscope')}
                  >
                    <option value="deepseek">DeepSeek（deepseek-chat）</option>
                    <option value="dashscope">Qwen（qwen3-max）</option>
                  </select>
                </label>
                {imagePromptStatus ? <p className="status">{imagePromptStatus}</p> : null}
                {imagePromptJob ? <p className="meta">任务ID：{imagePromptJob.id}</p> : null}
                {imagePrompt?.prompt ? (
                  <pre className="social-digest-output">{imagePrompt.prompt}</pre>
                ) : (
                  <p className="empty">点击生成，基于上方社媒文案输出可直接用于 nano banana 的图片 Prompt。</p>
                )}
                {imagePrompt ? (
                  <p className="meta">
                    要点 {imagePrompt.usedItems}/{imagePrompt.totalItems} 条 · 时间范围{' '}
                    {new Date(imagePrompt.periodStart).toLocaleString()} - {new Date(imagePrompt.periodEnd).toLocaleString()}
                  </p>
                ) : null}
              </div>
              </>
            ) : null}
          </article>
        </div>
      </section>
    </>
  );
}

function linkifyTweetIds(markdown: string) {
  const wrap = (id: string) => `[${id}](https://x.com/i/web/status/${id})`;
  return markdown
    .replace(/(\()(\d{10,})(\))/g, (_, open: string, id: string, close: string) => `${open}${wrap(id)}${close}`)
    .replace(/(（来源[:：]?\s*)(\d{10,})(）)/g, (_, prefix: string, id: string, suffix: string) => `${prefix}${wrap(id)}${suffix}`)
    .replace(/(^-\s+)(\d{10,})(\s*)$/gm, (_, bullet: string, id: string, trailing: string) => `${bullet}${wrap(id)}${trailing}`)
    .replace(/(tweet\s*id[:：]\s*)(\d{10,})/gi, (_, prefix: string, id: string) => `${prefix}${wrap(id)}`);
}
