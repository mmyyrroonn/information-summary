const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSourceTweetScopeFilter } = require('./sourceTweetScope.ts');

test('builds a tweet filter from twitter source subscription ids and identifiers', () => {
  const filter = buildSourceTweetScopeFilter([
    { platform: 'TWITTER', identifier: 'Alice', subscriptionId: 'sub-1' },
    { platform: 'YOUTUBE', identifier: 'channel-1', subscriptionId: null },
    { platform: 'TWITTER', identifier: '@Bob', subscriptionId: null },
    { platform: 'TWITTER', identifier: 'alice', subscriptionId: 'sub-1' }
  ]);

  assert.deepEqual(filter, {
    OR: [
      { subscriptionId: { in: ['sub-1'] } },
      { subscription: { screenName: { in: ['alice', 'bob'] } } }
    ]
  });
});

test('returns an empty filter when the source scope has no twitter people', () => {
  const filter = buildSourceTweetScopeFilter([{ platform: 'YOUTUBE', identifier: 'channel-1', subscriptionId: null }]);

  assert.deepEqual(filter, { id: { in: [] } });
});
