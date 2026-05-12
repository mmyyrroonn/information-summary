import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTweetMedia } from './tweetMedia';

test('extracts tweet photo URLs from RapidAPI media groups', () => {
  const media = extractTweetMedia({
    media: {
      photo: [
        {
          media_url_https: 'https://pbs.twimg.com/media/example.jpg?format=jpg&name=small',
          url: 'https://t.co/short1',
          expanded_url: 'https://x.com/example/status/123/photo/1'
        }
      ]
    }
  });

  assert.deepEqual(media, [
    {
      type: 'photo',
      url: 'https://pbs.twimg.com/media/example.jpg?format=jpg&name=small',
      expandedUrl: 'https://x.com/example/status/123/photo/1',
      shortUrl: 'https://t.co/short1'
    }
  ]);
});

test('extracts tweet media from Twitter entity shapes and removes duplicates', () => {
  const media = extractTweetMedia({
    entities: {
      media: [
        {
          type: 'photo',
          media_url: 'http://pbs.twimg.com/media/entity.jpg',
          media_url_https: 'https://pbs.twimg.com/media/entity.jpg',
          url: 'https://t.co/entity',
          expanded_url: 'https://twitter.com/example/status/123/photo/1'
        }
      ]
    },
    extended_entities: {
      media: [
        {
          type: 'photo',
          media_url_https: 'https://pbs.twimg.com/media/entity.jpg',
          url: 'https://t.co/entity'
        }
      ]
    }
  });

  assert.deepEqual(media, [
    {
      type: 'photo',
      url: 'https://pbs.twimg.com/media/entity.jpg',
      expandedUrl: 'https://twitter.com/example/status/123/photo/1',
      shortUrl: 'https://t.co/entity'
    }
  ]);
});

test('uses direct image URLs from Twitter API v2 includes but ignores bare t.co links', () => {
  const media = extractTweetMedia({
    includes: {
      media: [
        {
          type: 'photo',
          url: 'https://pbs.twimg.com/media/v2-image.png'
        },
        {
          type: 'photo',
          url: 'https://t.co/not-direct',
          expanded_url: 'https://x.com/example/status/123/photo/1'
        }
      ]
    }
  });

  assert.deepEqual(media, [
    {
      type: 'photo',
      url: 'https://pbs.twimg.com/media/v2-image.png'
    }
  ]);
});
