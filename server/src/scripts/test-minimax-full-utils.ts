export interface ClassifiedItem {
  tweetId: string;
  verdict?: string;
  summary?: string;
  importance?: number;
  tags?: string[];
}

export interface MatchedResponse {
  items: ClassifiedItem[];
}

export interface ResponseValidationResult {
  ok: boolean;
  error?: string;
  parsed?: MatchedResponse;
}

export function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    return [items];
  }
  if (items.length === 0) return [];

  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

export function validateResponseJson(content: string, allowedTweetIds: string[]): ResponseValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'response is not a JSON object' };
  }

  const candidate = parsed as { items?: unknown };
  if (!Array.isArray(candidate.items)) {
    return { ok: false, error: 'response.items must be an array' };
  }

  const items: ClassifiedItem[] = [];
  for (const value of candidate.items) {
    if (!value || typeof value !== 'object') {
      return { ok: false, error: 'each item must be an object' };
    }
    const item = value as Record<string, unknown>;
    if (typeof item.tweetId !== 'string' || !item.tweetId.trim()) {
      return { ok: false, error: 'each item.tweetId must be a non-empty string' };
    }
    const normalized: ClassifiedItem = { tweetId: item.tweetId };
    if (typeof item.verdict === 'string') normalized.verdict = item.verdict;
    if (typeof item.summary === 'string') normalized.summary = item.summary;
    if (typeof item.importance === 'number') normalized.importance = item.importance;
    if (Array.isArray(item.tags)) {
      normalized.tags = item.tags.filter((tag): tag is string => typeof tag === 'string');
    }
    items.push(normalized);
  }

  const itemTweetIds = items.map((item) => item.tweetId);
  const seenCount = new Map<string, number>();
  for (const tweetId of itemTweetIds) {
    seenCount.set(tweetId, (seenCount.get(tweetId) || 0) + 1);
  }

  const duplicates = [...seenCount.entries()]
    .filter(([, count]) => count > 1)
    .map(([tweetId]) => tweetId);
  const expectedSet = new Set(allowedTweetIds);
  const missing = allowedTweetIds.filter((tweetId) => !seenCount.has(tweetId));
  const unexpected = [...seenCount.keys()].filter((tweetId) => !expectedSet.has(tweetId));

  if (missing.length > 0 || duplicates.length > 0 || unexpected.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing tweetId: ${missing.join(', ')}`);
    if (duplicates.length > 0) parts.push(`duplicate tweetId: ${duplicates.join(', ')}`);
    if (unexpected.length > 0) parts.push(`unexpected tweetId: ${unexpected.join(', ')}`);
    return {
      ok: false,
      parsed: { items },
      error: parts.join('; ')
    };
  }

  return {
    ok: true,
    parsed: { items }
  };
}
