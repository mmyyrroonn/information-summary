/**
 * YouTube PoC — verify channel video listing + transcript fetching.
 *
 * Run:
 *   cd server
 *   YOUTUBE_API_KEY=xxx YOUTUBE_TEST_CHANNEL=@veritasium \
 *     npx ts-node-dev --transpile-only src/services/sources/poc/youtube.poc.ts
 *
 * What it tests:
 *   1. Resolve a channel handle (@xxx) or ID (UCxxxxx) → uploads playlist
 *   2. List recent videos from that uploads playlist
 *   3. Fetch full metadata (description, duration, view count) for each video
 *   4. Pull transcript via youtube-transcript (no quota cost)
 *   5. Print quota cost and field samples
 */

import { google, youtube_v3 } from 'googleapis';
import { YoutubeTranscript } from 'youtube-transcript';

const API_KEY = process.env.YOUTUBE_API_KEY;
const TEST_CHANNEL = process.env.YOUTUBE_TEST_CHANNEL ?? '@veritasium';
const MAX_VIDEOS = Number(process.env.YOUTUBE_TEST_MAX ?? 3);

if (!API_KEY) {
  console.error('Missing YOUTUBE_API_KEY env var');
  process.exit(1);
}

const youtube = google.youtube({ version: 'v3', auth: API_KEY });

interface QuotaTracker {
  total: number;
  breakdown: Record<string, number>;
}

const quota: QuotaTracker = { total: 0, breakdown: {} };
function chargeQuota(op: string, units: number) {
  quota.total += units;
  quota.breakdown[op] = (quota.breakdown[op] ?? 0) + units;
}

async function resolveUploadsPlaylistId(input: string): Promise<{ channelId: string; uploadsPlaylistId: string; title: string }> {
  const params: youtube_v3.Params$Resource$Channels$List = {
    part: ['contentDetails', 'snippet'],
    maxResults: 1
  };

  if (input.startsWith('@')) {
    params.forHandle = input;
  } else if (input.startsWith('UC')) {
    params.id = [input];
  } else {
    params.forUsername = input;
  }

  const response = await youtube.channels.list(params);
  chargeQuota('channels.list', 1);

  const channel = response.data.items?.[0];
  if (!channel) {
    throw new Error(`Channel not found for input: ${input}`);
  }

  const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) {
    throw new Error('Channel has no uploads playlist');
  }

  return {
    channelId: channel.id ?? '',
    uploadsPlaylistId,
    title: channel.snippet?.title ?? ''
  };
}

async function listRecentVideoIds(playlistId: string, max: number): Promise<string[]> {
  const response = await youtube.playlistItems.list({
    part: ['contentDetails'],
    playlistId,
    maxResults: max
  });
  chargeQuota('playlistItems.list', 1);

  return (response.data.items ?? [])
    .map((item) => item.contentDetails?.videoId)
    .filter((id): id is string => Boolean(id));
}

async function fetchVideoDetails(videoIds: string[]): Promise<youtube_v3.Schema$Video[]> {
  if (videoIds.length === 0) return [];
  const response = await youtube.videos.list({
    part: ['snippet', 'contentDetails', 'statistics'],
    id: videoIds
  });
  chargeQuota('videos.list', 1);
  return response.data.items ?? [];
}

interface TranscriptResult {
  videoId: string;
  ok: boolean;
  language?: string;
  segments?: number;
  totalChars?: number;
  preview?: string;
  error?: string;
}

async function tryTranscript(videoId: string, lang?: string): Promise<TranscriptResult> {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId, lang ? { lang } : {});
    const text = segments.map((s) => s.text).join(' ');
    return {
      videoId,
      ok: true,
      language: lang ?? 'auto',
      segments: segments.length,
      totalChars: text.length,
      preview: text.slice(0, 200)
    };
  } catch (err) {
    return {
      videoId,
      ok: false,
      language: lang ?? 'auto',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function formatVideo(video: youtube_v3.Schema$Video) {
  return {
    videoId: video.id,
    title: video.snippet?.title,
    channelTitle: video.snippet?.channelTitle,
    publishedAt: video.snippet?.publishedAt,
    description: video.snippet?.description?.slice(0, 200),
    descriptionLength: video.snippet?.description?.length ?? 0,
    duration: video.contentDetails?.duration,
    viewCount: video.statistics?.viewCount,
    likeCount: video.statistics?.likeCount,
    commentCount: video.statistics?.commentCount,
    thumbnailUrl: video.snippet?.thumbnails?.high?.url,
    tags: video.snippet?.tags?.slice(0, 5)
  };
}

async function main() {
  console.log(`\n=== YouTube PoC ===`);
  console.log(`Channel input: ${TEST_CHANNEL}`);
  console.log(`Max videos: ${MAX_VIDEOS}\n`);

  const startedAt = Date.now();

  console.log('[1/4] Resolving channel...');
  const channel = await resolveUploadsPlaylistId(TEST_CHANNEL);
  console.log('  →', channel);

  console.log('\n[2/4] Listing recent video IDs...');
  const videoIds = await listRecentVideoIds(channel.uploadsPlaylistId, MAX_VIDEOS);
  console.log('  →', videoIds);

  console.log('\n[3/4] Fetching video details...');
  const videos = await fetchVideoDetails(videoIds);
  videos.forEach((v, i) => {
    console.log(`\n  Video ${i + 1}:`, formatVideo(v));
  });

  console.log('\n[4/4] Pulling transcripts (auto — best available language)...');
  for (const v of videos) {
    if (!v.id) continue;
    console.log(`\n  Video: ${v.id} - ${v.snippet?.title}`);
    const auto = await tryTranscript(v.id);
    console.log('    result:', { ok: auto.ok, segments: auto.segments, chars: auto.totalChars, error: auto.error });
    if (auto.ok && auto.preview) {
      console.log('    preview:', JSON.stringify(auto.preview));
    }
  }

  const elapsed = Date.now() - startedAt;
  console.log('\n=== Summary ===');
  console.log('Elapsed:', `${elapsed}ms`);
  console.log('Quota used:', quota);
  console.log('Free daily quota: 10,000 units');
  console.log(`At this rate, you can monitor ~${Math.floor(10000 / quota.total)} channels/day with ${MAX_VIDEOS} videos each.`);
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  if (err.response?.data) {
    console.error('API response:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
