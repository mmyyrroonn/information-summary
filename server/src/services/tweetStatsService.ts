import { Prisma } from '@prisma/client';
import { prisma } from '../db';

const LENGTH_BUCKETS = [
  { label: '0-40', min: 0, max: 40 },
  { label: '41-80', min: 41, max: 80 },
  { label: '81-140', min: 81, max: 140 },
  { label: '141-200', min: 141, max: 200 },
  { label: '201-260', min: 201, max: 260 },
  { label: '261+', min: 261, max: null }
];

const VIEW_BUCKETS = [
  { label: '0-1k', min: 0, max: 999 },
  { label: '1k-5k', min: 1000, max: 4999 },
  { label: '5k-10k', min: 5000, max: 9999 },
  { label: '10k+', min: 10000, max: null }
];

const STATS_BATCH_SIZE = 2000;

const IMPORTANCE_LEVELS = [1, 2, 3, 4, 5];

export interface TweetStatsOptions {
  startTime?: Date;
  endTime?: Date;
  subscriptionId?: string;
  highScoreMinImportance?: number;
  tagLimit?: number;
  authorLimit?: number;
}

export interface TweetStatsResponse {
  range: {
    startTime: string | null;
    endTime: string | null;
    subscriptionId: string | null;
  };
  totals: {
    totalTweets: number;
    scoredTweets: number;
    viewTweets: number;
    highScoreMinImportance: number;
    highScoreTweets: number;
    avgLength: number | null;
    medianLength: number | null;
    p90Length: number | null;
    avgViews: number | null;
    medianViews: number | null;
    p90Views: number | null;
    avgImportance: number | null;
    lengthImportanceCorrelation: number | null;
  };
  lengthBuckets: Array<{
    label: string;
    min: number;
    max: number | null;
    count: number;
    avgLength: number | null;
    avgImportance: number | null;
    avgViews: number | null;
  }>;
  viewBuckets: Array<{
    label: string;
    min: number;
    max: number | null;
    count: number;
    avgViews: number | null;
    avgImportance: number | null;
    avgLength: number | null;
  }>;
  lengthByImportance: Array<{
    importance: number;
    count: number;
    avgLength: number | null;
    minLength: number | null;
    maxLength: number | null;
    medianLength: number | null;
    p90Length: number | null;
    avgViews: number | null;
  }>;
  scoreLengthMatrix: {
    buckets: Array<{ label: string; min: number; max: number | null }>;
    rows: Array<{ importance: number; counts: number[]; total: number; avgLength: number | null; avgViews: number | null }>;
  };
  scoreViewMatrix: {
    buckets: Array<{ label: string; min: number; max: number | null }>;
    rows: Array<{ importance: number; counts: number[]; total: number; avgViews: number | null }>;
  };
  verdictStats: Array<{
    verdict: string;
    count: number;
    avgLength: number | null;
    avgImportance: number | null;
    avgViews: number | null;
  }>;
  tagStats: Array<{
    tag: string;
    count: number;
    avgLength: number | null;
    avgImportance: number | null;
    avgViews: number | null;
    highScoreRatio: number | null;
  }>;
  highScoreProfile: {
    minImportance: number;
    count: number;
    ratio: number | null;
    avgLength: number | null;
    medianLength: number | null;
    p90Length: number | null;
    viewCount: number;
    avgViews: number | null;
    medianViews: number | null;
    p90Views: number | null;
    avgTagsPerTweet: number | null;
    suggestionRate: number | null;
    summaryRate: number | null;
    verdicts: Array<{ verdict: string; count: number; share: number }>;
    tags: Array<{ tag: string; count: number; share: number }>;
    authors: Array<{ author: string; count: number; share: number }>;
    languages: Array<{ lang: string; count: number; share: number }>;
    lengthBuckets: Array<{ label: string; count: number; share: number }>;
  };
}

function average(sum: number, count: number) {
  return count ? sum / count : null;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = ratio * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) {
    return null;
  }
  if (lower === upper) {
    return lowerValue;
  }
  const weight = position - lower;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function correlation(pairs: Array<[number, number]>) {
  if (pairs.length < 2) {
    return null;
  }
  let sumX = 0;
  let sumY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  let sumXY = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
    sumX2 += x * x;
    sumY2 += y * y;
    sumXY += x * y;
  }
  const n = pairs.length;
  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (!denominator) {
    return null;
  }
  return numerator / denominator;
}

function parseViewCount(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^([0-9,.]+)\s*([KMB])?$/i);
  if (match) {
    const rawNumber = match[1];
    if (!rawNumber) {
      return null;
    }
    const base = Number.parseFloat(rawNumber.replace(/,/g, ''));
    if (!Number.isFinite(base)) {
      return null;
    }
    const suffix = match[2]?.toUpperCase();
    const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
    return base * multiplier;
  }
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) {
    return null;
  }
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractViewCount(raw: Prisma.JsonValue | null | undefined) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const viewsValue = (raw as Record<string, unknown>).views;
  return parseViewCount(viewsValue);
}

function bucketIndex(length: number) {
  const idx = LENGTH_BUCKETS.findIndex((bucket) =>
    bucket.max === null ? length >= bucket.min : length >= bucket.min && length <= bucket.max
  );
  return idx === -1 ? LENGTH_BUCKETS.length - 1 : idx;
}

function viewBucketIndex(views: number) {
  const idx = VIEW_BUCKETS.findIndex((bucket) =>
    bucket.max === null ? views >= bucket.min : views >= bucket.min && views <= bucket.max
  );
  return idx === -1 ? VIEW_BUCKETS.length - 1 : idx;
}

export async function getTweetStats(options: TweetStatsOptions = {}): Promise<TweetStatsResponse> {
  const highScoreMinImportance = options.highScoreMinImportance ?? 4;
  const tagLimit = options.tagLimit ?? 12;
  const authorLimit = options.authorLimit ?? 8;

  const where: Prisma.TweetWhereInput = {};
  if (options.subscriptionId) {
    where.subscriptionId = options.subscriptionId;
  }
  if (options.startTime || options.endTime) {
    const timeFilter: Prisma.DateTimeFilter = {};
    if (options.startTime) {
      timeFilter.gte = options.startTime;
    }
    if (options.endTime) {
      timeFilter.lte = options.endTime;
    }
    where.tweetedAt = timeFilter;
  }

  const lengthValues: number[] = [];
  const viewValues: number[] = [];
  const scoredPairs: Array<[number, number]> = [];
  const lengthBucketStats = LENGTH_BUCKETS.map((bucket) => ({
    label: bucket.label,
    min: bucket.min,
    max: bucket.max,
    count: 0,
    lengthSum: 0,
    importanceSum: 0,
    importanceCount: 0,
    viewSum: 0,
    viewCount: 0
  }));
  const viewBucketStats = VIEW_BUCKETS.map((bucket) => ({
    label: bucket.label,
    min: bucket.min,
    max: bucket.max,
    count: 0,
    viewSum: 0,
    importanceSum: 0,
    importanceCount: 0,
    lengthSum: 0
  }));

  const importanceStats = new Map<
    number,
    { count: number; lengthSum: number; min: number; max: number; lengths: number[]; viewSum: number; viewCount: number }
  >();
  const matrixRows = IMPORTANCE_LEVELS.map(() => LENGTH_BUCKETS.map(() => 0));
  const viewMatrixRows = IMPORTANCE_LEVELS.map(() => VIEW_BUCKETS.map(() => 0));

  const verdictStats = new Map<
    string,
    { count: number; lengthSum: number; importanceSum: number; importanceCount: number; viewSum: number; viewCount: number }
  >();
  const tagStats = new Map<
    string,
    {
      count: number;
      lengthSum: number;
      importanceSum: number;
      importanceCount: number;
      viewSum: number;
      viewCount: number;
      highScoreCount: number;
    }
  >();

  let totalTweets = 0;
  let scoredTweets = 0;
  let viewTweets = 0;
  let importanceSum = 0;
  let highScoreTweets = 0;

  const highScoreLengths: number[] = [];
  const highScoreViews: number[] = [];
  const highScoreVerdicts = new Map<string, number>();
  const highScoreTags = new Map<string, number>();
  const highScoreAuthors = new Map<string, number>();
  const highScoreLanguages = new Map<string, number>();
  const highScoreLengthBuckets = LENGTH_BUCKETS.map((bucket) => ({ label: bucket.label, count: 0 }));
  let highScoreTagTotal = 0;
  let highScoreSuggestionCount = 0;
  let highScoreSummaryCount = 0;

  let lastId: string | null = null;
  while (true) {
    const batchWhere: Prisma.TweetWhereInput = lastId ? { ...where, id: { gt: lastId } } : where;
    const batch = await prisma.tweet.findMany({
      where: batchWhere,
      orderBy: { id: 'asc' },
      take: STATS_BATCH_SIZE,
      select: {
        id: true,
        text: true,
        lang: true,
        authorName: true,
        authorScreen: true,
        raw: true,
        insights: {
          select: {
            verdict: true,
            importance: true,
            tags: true,
            summary: true,
            suggestions: true
          }
        }
      }
    });

    if (!batch.length) {
      break;
    }

    for (const tweet of batch) {
      totalTweets += 1;
      const length = tweet.text.length;
      lengthValues.push(length);
      const bucketIdx = bucketIndex(length);
      const bucket = lengthBucketStats[bucketIdx] ?? lengthBucketStats[lengthBucketStats.length - 1];
      if (bucket) {
        bucket.count += 1;
        bucket.lengthSum += length;
      }

      const insights = tweet.insights;
      const importance = typeof insights?.importance === 'number' ? insights.importance : null;
      const viewCount = extractViewCount(tweet.raw);
      if (typeof viewCount === 'number') {
        viewValues.push(viewCount);
        viewTweets += 1;
        const viewIdx = viewBucketIndex(viewCount);
        const viewBucket = viewBucketStats[viewIdx] ?? viewBucketStats[viewBucketStats.length - 1];
        if (viewBucket) {
          viewBucket.count += 1;
          viewBucket.viewSum += viewCount;
          viewBucket.lengthSum += length;
        }
        if (bucket) {
          bucket.viewSum += viewCount;
          bucket.viewCount += 1;
        }
      }
      if (typeof importance === 'number') {
        scoredTweets += 1;
        importanceSum += importance;
        scoredPairs.push([length, importance]);
        if (bucket) {
          bucket.importanceSum += importance;
          bucket.importanceCount += 1;
        }
        if (typeof viewCount === 'number') {
          const viewIdx = viewBucketIndex(viewCount);
          const viewBucket = viewBucketStats[viewIdx] ?? viewBucketStats[viewBucketStats.length - 1];
          if (viewBucket) {
            viewBucket.importanceSum += importance;
            viewBucket.importanceCount += 1;
          }
        }

        if (!importanceStats.has(importance)) {
          importanceStats.set(importance, {
            count: 0,
            lengthSum: 0,
            min: length,
            max: length,
            lengths: [],
            viewSum: 0,
            viewCount: 0
          });
        }
        const impStats = importanceStats.get(importance)!;
        impStats.count += 1;
        impStats.lengthSum += length;
        impStats.min = Math.min(impStats.min, length);
        impStats.max = Math.max(impStats.max, length);
        impStats.lengths.push(length);
        if (typeof viewCount === 'number') {
          impStats.viewSum += viewCount;
          impStats.viewCount += 1;
        }

        const rowIndex = IMPORTANCE_LEVELS.indexOf(importance);
        if (rowIndex >= 0) {
          const row = matrixRows[rowIndex];
          if (row) {
            row[bucketIdx] = (row[bucketIdx] ?? 0) + 1;
          }
          if (typeof viewCount === 'number') {
            const viewRow = viewMatrixRows[rowIndex];
            const viewIdx = viewBucketIndex(viewCount);
            if (viewRow) {
              viewRow[viewIdx] = (viewRow[viewIdx] ?? 0) + 1;
            }
          }
        }
      }

      if (insights?.verdict) {
        if (!verdictStats.has(insights.verdict)) {
          verdictStats.set(insights.verdict, {
            count: 0,
            lengthSum: 0,
            importanceSum: 0,
            importanceCount: 0,
            viewSum: 0,
            viewCount: 0
          });
        }
        const verdictEntry = verdictStats.get(insights.verdict)!;
        verdictEntry.count += 1;
        verdictEntry.lengthSum += length;
        if (typeof importance === 'number') {
          verdictEntry.importanceSum += importance;
          verdictEntry.importanceCount += 1;
        }
        if (typeof viewCount === 'number') {
          verdictEntry.viewSum += viewCount;
          verdictEntry.viewCount += 1;
        }
      }

      if (Array.isArray(insights?.tags)) {
        for (const tag of insights.tags) {
          if (!tag) continue;
          if (!tagStats.has(tag)) {
            tagStats.set(tag, {
              count: 0,
              lengthSum: 0,
              importanceSum: 0,
              importanceCount: 0,
              viewSum: 0,
              viewCount: 0,
              highScoreCount: 0
            });
          }
          const tagEntry = tagStats.get(tag)!;
          tagEntry.count += 1;
          tagEntry.lengthSum += length;
          if (typeof importance === 'number') {
            tagEntry.importanceSum += importance;
            tagEntry.importanceCount += 1;
          }
          if (typeof viewCount === 'number') {
            tagEntry.viewSum += viewCount;
            tagEntry.viewCount += 1;
          }
          if (typeof importance === 'number' && importance >= highScoreMinImportance) {
            tagEntry.highScoreCount += 1;
          }
        }
      }

      if (typeof importance === 'number' && importance >= highScoreMinImportance) {
        highScoreTweets += 1;
        highScoreLengths.push(length);
        const highBucket = highScoreLengthBuckets[bucketIdx] ?? highScoreLengthBuckets[highScoreLengthBuckets.length - 1];
        if (highBucket) {
          highBucket.count += 1;
        }
        if (typeof viewCount === 'number') {
          highScoreViews.push(viewCount);
        }
        const verdict = insights?.verdict ?? 'unknown';
        highScoreVerdicts.set(verdict, (highScoreVerdicts.get(verdict) ?? 0) + 1);
        if (Array.isArray(insights?.tags)) {
          for (const tag of insights.tags) {
            if (!tag) continue;
            highScoreTags.set(tag, (highScoreTags.get(tag) ?? 0) + 1);
            highScoreTagTotal += 1;
          }
        }
        const authorLabel = tweet.authorName
          ? `${tweet.authorName} (@${tweet.authorScreen})`
          : `@${tweet.authorScreen}`;
        highScoreAuthors.set(authorLabel, (highScoreAuthors.get(authorLabel) ?? 0) + 1);
        const lang = tweet.lang ?? 'unknown';
        highScoreLanguages.set(lang, (highScoreLanguages.get(lang) ?? 0) + 1);
        if (insights?.suggestions && insights.suggestions.trim()) {
          highScoreSuggestionCount += 1;
        }
        if (insights?.summary && insights.summary.trim()) {
          highScoreSummaryCount += 1;
        }
      }
    }

    lastId = batch[batch.length - 1]?.id ?? null;
  }

  const lengthByImportance = IMPORTANCE_LEVELS.map((importance) => {
    const stats = importanceStats.get(importance);
    if (!stats) {
      return {
        importance,
        count: 0,
        avgLength: null,
        minLength: null,
        maxLength: null,
        medianLength: null,
        p90Length: null,
        avgViews: null
      };
    }
    return {
      importance,
      count: stats.count,
      avgLength: average(stats.lengthSum, stats.count),
      minLength: stats.min,
      maxLength: stats.max,
      medianLength: percentile(stats.lengths, 0.5),
      p90Length: percentile(stats.lengths, 0.9),
      avgViews: average(stats.viewSum, stats.viewCount)
    };
  });

  const scoreLengthMatrix = {
    buckets: LENGTH_BUCKETS.map((bucket) => ({ label: bucket.label, min: bucket.min, max: bucket.max })),
    rows: IMPORTANCE_LEVELS.map((importance, idx) => {
      const row = matrixRows[idx] ?? LENGTH_BUCKETS.map(() => 0);
      const summary = lengthByImportance[idx];
      return {
        importance,
        counts: row,
        total: row.reduce((sum, value) => sum + value, 0),
        avgLength: summary ? summary.avgLength : null,
        avgViews: summary ? summary.avgViews : null
      };
    })
  };

  const scoreViewMatrix = {
    buckets: VIEW_BUCKETS.map((bucket) => ({ label: bucket.label, min: bucket.min, max: bucket.max })),
    rows: IMPORTANCE_LEVELS.map((importance, idx) => {
      const row = viewMatrixRows[idx] ?? VIEW_BUCKETS.map(() => 0);
      const summary = lengthByImportance[idx];
      return {
        importance,
        counts: row,
        total: row.reduce((sum, value) => sum + value, 0),
        avgViews: summary ? summary.avgViews : null
      };
    })
  };

  const verdictStatsList = Array.from(verdictStats.entries())
    .map(([verdict, stats]) => ({
      verdict,
      count: stats.count,
      avgLength: average(stats.lengthSum, stats.count),
      avgImportance: average(stats.importanceSum, stats.importanceCount),
      avgViews: average(stats.viewSum, stats.viewCount)
    }))
    .sort((a, b) => b.count - a.count);

  const tagStatsList = Array.from(tagStats.entries())
    .map(([tag, stats]) => ({
      tag,
      count: stats.count,
      avgLength: average(stats.lengthSum, stats.count),
      avgImportance: average(stats.importanceSum, stats.importanceCount),
      avgViews: average(stats.viewSum, stats.viewCount),
      highScoreRatio: stats.importanceCount ? stats.highScoreCount / stats.importanceCount : null
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, tagLimit);

  const highScoreRatio = scoredTweets ? highScoreTweets / scoredTweets : null;
  const highScoreLengthBucketList = highScoreLengthBuckets.map((bucket) => ({
    label: bucket.label,
    count: bucket.count,
    share: highScoreTweets ? bucket.count / highScoreTweets : 0
  }));

  const highScoreProfile = {
    minImportance: highScoreMinImportance,
    count: highScoreTweets,
    ratio: highScoreRatio,
    avgLength: average(highScoreLengths.reduce((sum, value) => sum + value, 0), highScoreLengths.length),
    medianLength: percentile(highScoreLengths, 0.5),
    p90Length: percentile(highScoreLengths, 0.9),
    viewCount: highScoreViews.length,
    avgViews: average(highScoreViews.reduce((sum, value) => sum + value, 0), highScoreViews.length),
    medianViews: percentile(highScoreViews, 0.5),
    p90Views: percentile(highScoreViews, 0.9),
    avgTagsPerTweet: highScoreTweets ? highScoreTagTotal / highScoreTweets : null,
    suggestionRate: highScoreTweets ? highScoreSuggestionCount / highScoreTweets : null,
    summaryRate: highScoreTweets ? highScoreSummaryCount / highScoreTweets : null,
    verdicts: Array.from(highScoreVerdicts.entries())
      .map(([verdict, count]) => ({
        verdict,
        count,
        share: highScoreTweets ? count / highScoreTweets : 0
      }))
      .sort((a, b) => b.count - a.count),
    tags: Array.from(highScoreTags.entries())
      .map(([tag, count]) => ({
        tag,
        count,
        share: highScoreTweets ? count / highScoreTweets : 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, tagLimit),
    authors: Array.from(highScoreAuthors.entries())
      .map(([author, count]) => ({
        author,
        count,
        share: highScoreTweets ? count / highScoreTweets : 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, authorLimit),
    languages: Array.from(highScoreLanguages.entries())
      .map(([lang, count]) => ({
        lang,
        count,
        share: highScoreTweets ? count / highScoreTweets : 0
      }))
      .sort((a, b) => b.count - a.count),
    lengthBuckets: highScoreLengthBucketList
  };

  return {
    range: {
      startTime: options.startTime ? options.startTime.toISOString() : null,
      endTime: options.endTime ? options.endTime.toISOString() : null,
      subscriptionId: options.subscriptionId ?? null
    },
    totals: {
      totalTweets,
      scoredTweets,
      viewTweets,
      highScoreMinImportance,
      highScoreTweets,
      avgLength: average(lengthValues.reduce((sum, value) => sum + value, 0), lengthValues.length),
      medianLength: percentile(lengthValues, 0.5),
      p90Length: percentile(lengthValues, 0.9),
      avgViews: average(viewValues.reduce((sum, value) => sum + value, 0), viewValues.length),
      medianViews: percentile(viewValues, 0.5),
      p90Views: percentile(viewValues, 0.9),
      avgImportance: average(importanceSum, scoredTweets),
      lengthImportanceCorrelation: correlation(scoredPairs)
    },
    lengthBuckets: lengthBucketStats.map((bucket) => ({
      label: bucket.label,
      min: bucket.min,
      max: bucket.max,
      count: bucket.count,
      avgLength: average(bucket.lengthSum, bucket.count),
      avgImportance: average(bucket.importanceSum, bucket.importanceCount),
      avgViews: average(bucket.viewSum, bucket.viewCount)
    })),
    viewBuckets: viewBucketStats.map((bucket) => ({
      label: bucket.label,
      min: bucket.min,
      max: bucket.max,
      count: bucket.count,
      avgViews: average(bucket.viewSum, bucket.count),
      avgImportance: average(bucket.importanceSum, bucket.importanceCount),
      avgLength: average(bucket.lengthSum, bucket.count)
    })),
    lengthByImportance,
    scoreLengthMatrix,
    scoreViewMatrix,
    verdictStats: verdictStatsList,
    tagStats: tagStatsList,
    highScoreProfile
  };
}
