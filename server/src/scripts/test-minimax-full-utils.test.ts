import assert from 'node:assert/strict';
import test from 'node:test';
import { splitIntoBatches, validateResponseJson } from './test-minimax-full-utils';

test('validateResponseJson accepts exact tweetId match', () => {
  const content = JSON.stringify({
    items: [
      { tweetId: 't1', verdict: 'watch', summary: 's1', importance: 4, tags: ['policy'] },
      { tweetId: 't2', verdict: 'ignore', summary: 's2', importance: 2, tags: ['other'] }
    ]
  });

  const result = validateResponseJson(content, ['t1', 't2']);
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
});

test('validateResponseJson fails when response misses and duplicates tweetId', () => {
  const content = JSON.stringify({
    items: [
      { tweetId: 't1', verdict: 'watch', summary: 's1', importance: 4, tags: ['policy'] },
      { tweetId: 't1', verdict: 'ignore', summary: 's2', importance: 2, tags: ['other'] }
    ]
  });

  const result = validateResponseJson(content, ['t1', 't2']);
  assert.equal(result.ok, false);
  assert.match(result.error || '', /missing tweetId.*t2/i);
  assert.match(result.error || '', /duplicate tweetId.*t1/i);
});

test('splitIntoBatches splits 300 items into 15 batches when batchSize=20', () => {
  const items = Array.from({ length: 300 }, (_, i) => i + 1);
  const batches = splitIntoBatches(items, 20);

  assert.equal(batches.length, 15);
  assert.equal(batches[0]?.length, 20);
  assert.equal(batches[14]?.length, 20);
  assert.equal(batches.flat().length, 300);
});
