const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTextSummaryPairs } = require('./match-minimax-report');

test('extractTextSummaryPairs pairs input text with parsed summary by tweetId', () => {
  const report = {
    cases: [
      {
        tag: 'policy',
        batchSize: 2,
        chunkIndex: 1,
        totalChunks: 1,
        input: {
          tweets: [
            { tweetId: 't1', text: 'text-1', author: 'a', handle: 'h1' },
            { tweetId: 't2', text: 'text-2', author: 'b', handle: 'h2' }
          ]
        },
        output: {
          parsed: {
            items: [
              { tweetId: 't1', summary: 'sum-1', verdict: 'watch', importance: 4, tags: ['policy'] },
              { tweetId: 't2', summary: 'sum-2', verdict: 'ignore', importance: 1, tags: ['other'] }
            ]
          }
        }
      }
    ]
  };

  const rows = extractTextSummaryPairs(report);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    tag: 'policy',
    batchSize: 2,
    chunkIndex: 1,
    totalChunks: 1,
    tweetId: 't1',
    author: 'a',
    handle: 'h1',
    text: 'text-1',
    summary: 'sum-1',
    verdict: 'watch',
    importance: 4,
    tags: ['policy']
  });
});
