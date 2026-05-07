import assert from 'node:assert/strict';
import test from 'node:test';
import type { Tweet } from '@prisma/client';
import { applyRuleBasedRouting } from './routing';

function makeTweet(text: string): Tweet {
  return {
    id: 'tweet-id',
    tweetId: 'tweet-remote-id',
    subscriptionId: 'subscription-id',
    authorName: 'Trusted Source',
    authorScreen: 'trusted_source',
    text,
    tweetUrl: null,
    raw: {},
    tweetedAt: new Date('2026-05-07T00:00:00.000Z'),
    lang: 'zh',
    createdAt: new Date('2026-05-07T00:00:00.000Z'),
    processedAt: null,
    abandonedAt: null,
    abandonReason: null,
    routingStatus: 'PENDING',
    routingTag: null,
    routingDomain: null,
    routingScore: null,
    routingMargin: null,
    routingReason: null,
    routedAt: null,
    llmQueuedAt: null,
    embeddingScore: null
  } as Tweet;
}

test('trusted source mode keeps short low-keyword tweets for LLM review', () => {
  const tweet = makeTweet('今晚这个变化有点意思，晚点再展开。');
  const result = applyRuleBasedRouting([tweet], { trustedSourceMode: true });

  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.analyze.map((item: Tweet) => item.tweetId), [tweet.tweetId]);
  assert.equal(result.reasonCounts.get('trusted-source-keep'), 1);
});
