/**
 * WeChat Official Account PoC — verify Wechat2RSS feed parsing.
 *
 * Run:
 *   cd server
 *   WECHAT_RSS_FEED_URL=https://wechat2rss.xlab.app/feed/<feed_id>.xml \
 *     npx ts-node-dev --transpile-only src/services/sources/poc/wechat-rss.poc.ts
 *
 * Wechat2RSS landing page: https://wechat2rss.xlab.app
 *   - You search/subscribe to a 公众号, get a feed URL like:
 *     https://wechat2rss.xlab.app/feed/<sha1>.xml
 *
 * What it tests:
 *   1. Service reachability
 *   2. RSS field shape: title / link / pubDate / content / contentSnippet / creator
 *   3. Whether content is full HTML or just a snippet
 *   4. Recency of items (gauge feed update latency)
 */

import Parser from 'rss-parser';

const FEED_URL = process.env.WECHAT_RSS_FEED_URL;

if (!FEED_URL) {
  console.error('Missing WECHAT_RSS_FEED_URL env var');
  console.error('Get a feed URL from https://wechat2rss.xlab.app');
  console.error('Example: WECHAT_RSS_FEED_URL=https://wechat2rss.xlab.app/feed/abc123.xml');
  process.exit(1);
}

interface ExtraFields {
  'content:encoded'?: string;
  'content:encodedSnippet'?: string;
}

const parser: Parser<{}, ExtraFields> = new Parser({
  customFields: {
    item: ['content:encoded', 'content:encodedSnippet']
  },
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; InformationSummaryBot/1.0)'
  }
});

function summarizeItem(item: Parser.Item & ExtraFields, idx: number) {
  const contentEncoded = (item as any)['content:encoded'] as string | undefined;
  const html = contentEncoded ?? item.content ?? '';
  const stripped = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return {
    idx,
    title: item.title,
    link: item.link,
    pubDate: item.pubDate,
    isoDate: item.isoDate,
    creator: item.creator ?? (item as any).author,
    snippetLen: item.contentSnippet?.length ?? 0,
    contentEncodedLen: contentEncoded?.length ?? 0,
    plainTextLen: stripped.length,
    plainTextPreview: stripped.slice(0, 300),
    guid: item.guid,
    categories: item.categories
  };
}

async function main() {
  console.log(`\n=== WeChat (Wechat2RSS) PoC ===`);
  console.log(`Feed URL: ${FEED_URL}\n`);

  const startedAt = Date.now();
  console.log('[1/2] Fetching feed...');
  const feed = await parser.parseURL(FEED_URL!);
  console.log('  Elapsed:', `${Date.now() - startedAt}ms`);

  console.log('\n[2/2] Feed metadata:');
  console.log({
    title: feed.title,
    description: feed.description,
    link: feed.link,
    feedUrl: feed.feedUrl,
    language: (feed as any).language,
    lastBuildDate: (feed as any).lastBuildDate,
    itemCount: feed.items.length
  });

  console.log('\nLatest items:');
  feed.items.slice(0, 5).forEach((item, i) => {
    console.log('\n  Item:', summarizeItem(item as any, i + 1));
  });

  // Recency check
  if (feed.items.length > 0) {
    const newest = feed.items[0];
    const newestTs = newest?.isoDate ? new Date(newest.isoDate).getTime() : 0;
    if (newestTs > 0) {
      const ageMs = Date.now() - newestTs;
      const ageHours = (ageMs / 3_600_000).toFixed(1);
      console.log(`\nFeed freshness: latest item is ${ageHours}h old`);
    }
  }

  console.log('\n=== Notes ===');
  console.log('- Wechat2RSS typically has 6h delay');
  console.log('- "content:encoded" usually contains the full article HTML');
  console.log('- Each 公众号 needs its own feed URL; users subscribe via the web UI');
  console.log('- For our use, "title" + plain-text(content:encoded) → NormalizedPost.text');
}

main().catch((err) => {
  console.error('\nFAILED:', err.message ?? err);
  if (err.response) {
    console.error('HTTP status:', err.response?.status);
  }
  process.exit(1);
});
