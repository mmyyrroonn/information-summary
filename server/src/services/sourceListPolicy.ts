type SourcePlatformValue = 'TWITTER' | 'YOUTUBE' | 'BILIBILI' | 'WECHAT';

export type SourceDueCandidate = {
  id?: string;
  enabled: boolean;
  lastFetchedAt: Date | null;
};

export function normalizeSourceIdentifier(platform: SourcePlatformValue | string, identifier: string) {
  const trimmed = identifier.trim();
  if (platform === 'TWITTER') {
    return trimmed.replace(/^@/, '').toLowerCase();
  }
  return trimmed;
}

export function isSourceFetchDue(
  source: SourceDueCandidate,
  options: { now?: Date; cooldownHours: number; force?: boolean }
) {
  if (!source.enabled) {
    return false;
  }
  if (options.force || !source.lastFetchedAt) {
    return true;
  }
  const now = options.now ?? new Date();
  const cooldownMs = Math.max(0, options.cooldownHours) * 60 * 60 * 1000;
  return now.getTime() - source.lastFetchedAt.getTime() >= cooldownMs;
}

export function selectDueSources<T extends SourceDueCandidate>(
  sources: T[],
  options: { now?: Date; cooldownHours: number; force?: boolean; limit?: number }
) {
  const due = sources.filter((source) => isSourceFetchDue(source, options));
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : due.length;
  return due.slice(0, limit);
}
