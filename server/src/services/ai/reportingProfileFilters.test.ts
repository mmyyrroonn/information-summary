import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProfileFilters } from './reporting';

function makeInsight(tweetId: string, tags: string[]) {
  return {
    tweetId,
    verdict: 'actionable',
    importance: 3,
    tags,
    tweet: {
      tweetedAt: new Date('2026-04-30T00:00:00.000Z'),
      subscription: { tags: [] }
    }
  } as any;
}

function makeProfile(includeTweetTags: string[]) {
  return {
    includeTweetTags,
    excludeTweetTags: [],
    includeAuthorTags: [],
    excludeAuthorTags: [],
    verdicts: [],
    domains: [],
    minImportance: 1
  } as any;
}

test('empty included tweet tags keeps all tweet tags selected', () => {
  const { filtered } = applyProfileFilters(
    [makeInsight('macro', ['macro']), makeInsight('ai', ['ai'])],
    makeProfile([])
  );

  assert.deepEqual(
    filtered.map((insight: { tweetId: string }) => insight.tweetId),
    ['macro', 'ai']
  );
});

test('included tweet tags filter only when at least one tag is selected', () => {
  const { filtered } = applyProfileFilters(
    [makeInsight('macro', ['macro']), makeInsight('ai', ['ai'])],
    makeProfile(['macro'])
  );

  assert.deepEqual(
    filtered.map((insight: { tweetId: string }) => insight.tweetId),
    ['macro']
  );
});
