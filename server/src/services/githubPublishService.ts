import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import dayjs from 'dayjs';
import type { Report } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { buildHighScoreSummaryMarkdown } from './aiService';
import { sendHighScoreMarkdownToTelegram } from './notificationService';

const execFileAsync = promisify(execFile);

type PublishResult = {
  publishedAt: Date;
  url: string | null;
  indexUrl: string | null;
  reportPath: string;
  indexPath: string;
  branch: string;
  committed: boolean;
  pushed: boolean;
};

type GitRunResult = {
  stdout: string;
  stderr: string;
};

function buildGitEnv() {
  const env = { ...process.env };
  const sshCommand = buildSshCommand();
  if (sshCommand) {
    env.GIT_SSH_COMMAND = sshCommand;
  }
  return env;
}

function buildSshCommand() {
  const override = config.GITHUB_PAGES_SSH_COMMAND?.trim();
  if (override) {
    return override;
  }
  const keyPath = config.GITHUB_PAGES_SSH_KEY_PATH?.trim();
  if (!keyPath) {
    return null;
  }
  const needsQuotes = /\s/.test(keyPath);
  const quotedPath = needsQuotes ? `"${keyPath}"` : keyPath;
  return `ssh -i ${quotedPath} -o IdentitiesOnly=yes`;
}

function normalizeReportDir(dir: string) {
  const trimmed = dir.trim().replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
  return trimmed || 'reports';
}

function toPosixPath(value: string) {
  return value.replace(/\\/g, '/');
}

function buildReportFilename(report: Report) {
  const dateLabel = dayjs(report.periodEnd).format('YYYY-MM-DD');
  const suffix = report.id.slice(0, 8);
  return `${dateLabel}-${suffix}.md`;
}

function buildIndexEntry(dateLabel: string, headline: string, fileName: string) {
  const safeHeadline = headline.replace(/\r?\n/g, ' ').trim();
  return `- ${dateLabel} | ${safeHeadline} ([view](./${fileName}))`;
}

function buildIndexContent(existing: string | null, entry: string, fileName: string) {
  const header = '# Daily Reports';
  const lines = existing ? existing.split(/\r?\n/) : [header, ''];
  const firstLine = lines[0] ?? '';
  if (!lines.length || !firstLine.startsWith('#')) {
    lines.unshift(header, '');
  }
  const secondLine = lines[1] ?? '';
  if (lines.length >= 2 && secondLine.trim() !== '') {
    lines.splice(1, 0, '');
  }
  const entryIndex = lines.findIndex((line) => line.includes(`./${fileName}`));
  if (entryIndex >= 0) {
    lines[entryIndex] = entry;
  } else {
    const firstList = lines.findIndex((line) => line.trim().startsWith('- '));
    const insertAt = firstList >= 0 ? firstList : lines.length;
    lines.splice(insertAt, 0, entry);
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function runGit(repoPath: string, args: string[]) {
  const result = await execFileAsync('git', args, { cwd: repoPath, env: buildGitEnv() });
  return {
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? ''
  } satisfies GitRunResult;
}

async function runGitSafe(repoPath: string, args: string[]) {
  try {
    const result = await execFileAsync('git', args, { cwd: repoPath, env: buildGitEnv() });
    return {
      ok: true,
      stdout: result.stdout?.toString() ?? '',
      stderr: result.stderr?.toString() ?? ''
    };
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? ''
    };
  }
}

function extractGithubRepoSlug(remoteUrl: string) {
  const cleaned = remoteUrl.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const sshMatch = cleaned.match(/^git@github\.com:([^/]+\/[^/]+)$/i);
  if (sshMatch) {
    return sshMatch[1];
  }
  const sshAltMatch = cleaned.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/i);
  if (sshAltMatch) {
    return sshAltMatch[1];
  }
  const httpsMatch = cleaned.match(/^(?:https?|git):\/\/github\.com\/([^/]+\/[^/]+)$/i);
  if (httpsMatch) {
    return httpsMatch[1];
  }
  return null;
}

async function resolveGithubPreviewUrl(repoPath: string, branch: string, reportRelPath: string) {
  const remoteResult = await runGitSafe(repoPath, ['remote', 'get-url', 'origin']);
  if (!remoteResult.ok) {
    return null;
  }
  const remoteUrl = remoteResult.stdout.trim();
  if (!remoteUrl) {
    return null;
  }
  const slug = extractGithubRepoSlug(remoteUrl);
  if (!slug) {
    return null;
  }
  return `https://github.com/${slug}/blob/${branch}/${reportRelPath}`;
}

async function ensureRepoReady(repoPath: string, branch: string) {
  const stat = await fs.stat(repoPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`GitHub Pages repo path not found: ${repoPath}`);
  }
  const gitDir = await fs.stat(path.join(repoPath, '.git')).catch(() => null);
  if (!gitDir || !gitDir.isDirectory()) {
    throw new Error(`Missing .git directory in repo path: ${repoPath}`);
  }
  const branchResult = await runGitSafe(repoPath, ['symbolic-ref', '-q', '--short', 'HEAD']);
  const currentBranch = branchResult.ok ? branchResult.stdout.trim() : '';
  if (!currentBranch) {
    await runGit(repoPath, ['checkout', '-B', branch]);
    await ensureInitialCommit(repoPath);
    return;
  }
  if (currentBranch !== branch) {
    try {
      await runGit(repoPath, ['checkout', branch]);
    } catch {
      await runGit(repoPath, ['checkout', '-B', branch]);
    }
  }
  await ensureInitialCommit(repoPath);
}

async function ensureInitialCommit(repoPath: string) {
  const headResult = await runGitSafe(repoPath, ['rev-parse', '--verify', 'HEAD']);
  if (headResult.ok) {
    return;
  }
  await runGit(repoPath, [
    '-c',
    `user.name=${config.GITHUB_PAGES_COMMIT_NAME}`,
    '-c',
    `user.email=${config.GITHUB_PAGES_COMMIT_EMAIL}`,
    'commit',
    '--allow-empty',
    '-m',
    'Initialize Pages repo'
  ]);
}

async function stageAndCommit(repoPath: string, relPaths: string[], message: string) {
  await runGit(repoPath, ['add', ...relPaths]);
  const staged = await runGit(repoPath, ['diff', '--cached', '--name-only']);
  if (!staged.stdout.trim()) {
    return { committed: false };
  }
  await runGit(repoPath, [
    '-c',
    `user.name=${config.GITHUB_PAGES_COMMIT_NAME}`,
    '-c',
    `user.email=${config.GITHUB_PAGES_COMMIT_EMAIL}`,
    'commit',
    '-m',
    message
  ]);
  return { committed: true };
}

async function resolvePushRemote(repoPath: string) {
  const hasSsh = Boolean(config.GITHUB_PAGES_SSH_COMMAND?.trim() || config.GITHUB_PAGES_SSH_KEY_PATH?.trim());
  if (!hasSsh) {
    return 'origin';
  }
  const originResult = await runGitSafe(repoPath, ['remote', 'get-url', 'origin']);
  const originUrl = originResult.ok ? originResult.stdout.trim() : '';
  if (!originUrl) {
    return 'origin';
  }
  if (originUrl.startsWith('git@') || originUrl.startsWith('ssh://')) {
    return 'origin';
  }
  if (originUrl.startsWith('https://github.com/') || originUrl.startsWith('http://github.com/')) {
    return originUrl.replace(/^https?:\/\/github\.com\//, 'git@github.com:');
  }
  return 'origin';
}

export async function publishReportToGithub(report: Report): Promise<PublishResult> {
  const repoPath = config.GITHUB_PAGES_REPO_PATH?.trim();
  if (!repoPath) {
    throw new Error('GITHUB_PAGES_REPO_PATH missing');
  }
  const branch = config.GITHUB_PAGES_BRANCH.trim();
  const reportDir = normalizeReportDir(config.GITHUB_PAGES_REPORT_DIR);
  const indexFile = config.GITHUB_PAGES_INDEX_FILE.trim() || 'index.md';

  if (path.isAbsolute(reportDir)) {
    throw new Error('GITHUB_PAGES_REPORT_DIR must be a relative path');
  }

  await ensureRepoReady(repoPath, branch);

  const dateLabel = dayjs(report.periodEnd).format('YYYY-MM-DD');
  const fileName = buildReportFilename(report);
  const reportDirPath = path.join(repoPath, reportDir);
  const reportFilePath = path.join(reportDirPath, fileName);
  const indexPath = path.join(reportDirPath, indexFile);

  await fs.mkdir(reportDirPath, { recursive: true });
  await fs.writeFile(reportFilePath, `${report.content.trimEnd()}\n`, 'utf8');

  const existingIndex = await fs.readFile(indexPath, 'utf8').catch(() => null);
  const entry = buildIndexEntry(dateLabel, report.headline, fileName);
  const nextIndex = buildIndexContent(existingIndex, entry, fileName);
  await fs.writeFile(indexPath, nextIndex, 'utf8');

  const reportRelPath = toPosixPath(path.join(reportDir, fileName));
  const indexRelPath = toPosixPath(path.join(reportDir, indexFile));
  const commitMessage = `Publish report ${dateLabel} (${report.id.slice(0, 8)})`;

  const { committed } = await stageAndCommit(repoPath, [reportRelPath, indexRelPath], commitMessage);
  let pushed = false;
  if (committed) {
    const remote = await resolvePushRemote(repoPath);
    await runGit(repoPath, ['push', remote, branch]);
    pushed = true;
  }

  const publishedAt = report.publishedAt ?? new Date();
  if (!report.publishedAt) {
    await prisma.report.update({
      where: { id: report.id },
      data: { publishedAt }
    });
  }

  const baseUrl = config.GITHUB_PAGES_BASE_URL?.trim() || null;
  const normalizedBase = baseUrl ? baseUrl.replace(/\/+$/, '') : null;
  const url = normalizedBase ? `${normalizedBase}/${reportRelPath}` : null;
  const indexUrl = normalizedBase ? `${normalizedBase}/${toPosixPath(reportDir)}/` : null;
  let summaryDelivered = false;
  if (pushed) {
    const previewUrl = (await resolveGithubPreviewUrl(repoPath, branch, reportRelPath)) ?? url;
    if (previewUrl) {
      const summaryMarkdown = buildHighScoreSummaryMarkdown(report, previewUrl);
      try {
        summaryDelivered = Boolean(await sendHighScoreMarkdownToTelegram(summaryMarkdown));
      } catch (error) {
        logger.warn('High-score summary notification failed', {
          reportId: report.id,
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error
        });
      }
    } else {
      logger.warn('Missing GitHub preview URL, skipping high-score summary notification', { reportId: report.id });
    }
  }

  logger.info('Report published to GitHub Pages', {
    reportId: report.id,
    repoPath,
    branch,
    reportRelPath,
    committed,
    pushed,
    summaryDelivered
  });

  return {
    publishedAt,
    url,
    indexUrl,
    reportPath: reportRelPath,
    indexPath: indexRelPath,
    branch,
    committed,
    pushed
  };
}
