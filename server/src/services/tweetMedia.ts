export type TweetMediaType = 'photo' | 'video' | 'animated_gif' | 'unknown';

export interface TweetMediaItem {
  type: TweetMediaType;
  url: string;
  expandedUrl?: string;
  shortUrl?: string;
}

const DIRECT_IMAGE_KEYS = [
  'media_url_https',
  'media_url',
  'preview_image_url',
  'previewImageUrl',
  'thumbnail_url',
  'thumbnailUrl',
  'image_url',
  'imageUrl',
  'image',
  'src',
  'url'
];

const EXPANDED_URL_KEYS = ['expanded_url', 'expandedUrl', 'expanded_url_https'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readFirstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isTwitterShortUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === 't.co';
  } catch {
    return false;
  }
}

function isDirectImageUrl(value: string) {
  if (!isHttpUrl(value) || isTwitterShortUrl(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    const format = url.searchParams.get('format')?.toLowerCase() ?? '';
    return (
      hostname === 'pbs.twimg.com' ||
      hostname.endsWith('.twimg.com') ||
      /\.(avif|gif|jpe?g|png|webp)$/.test(pathname) ||
      ['avif', 'gif', 'jpg', 'jpeg', 'png', 'webp'].includes(format)
    );
  } catch {
    return false;
  }
}

function normalizeImageUrl(value: string) {
  if (value.startsWith('http://pbs.twimg.com/') || value.startsWith('http://ton.twimg.com/')) {
    return value.replace(/^http:/, 'https:');
  }
  return value;
}

function normalizeMediaType(value: unknown, hint?: TweetMediaType): TweetMediaType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'photo' || normalized === 'image') return 'photo';
  if (normalized === 'video') return 'video';
  if (normalized === 'animated_gif' || normalized === 'animatedgif' || normalized === 'gif') return 'animated_gif';
  return hint ?? 'unknown';
}

function directImageUrl(record: Record<string, unknown>) {
  for (const key of DIRECT_IMAGE_KEYS) {
    const value = stringValue(record[key]);
    if (value && isDirectImageUrl(value)) {
      return normalizeImageUrl(value);
    }
  }
  return null;
}

function maybeShortUrl(record: Record<string, unknown>) {
  const value = stringValue(record.url);
  return value && isTwitterShortUrl(value) ? value : null;
}

function maybeExpandedUrl(record: Record<string, unknown>, imageUrl: string) {
  const value = readFirstString(record, EXPANDED_URL_KEYS);
  if (!value || !isHttpUrl(value) || value === imageUrl) {
    return null;
  }
  return value;
}

function pushMedia(
  items: TweetMediaItem[],
  seen: Map<string, TweetMediaItem>,
  record: Record<string, unknown>,
  hint?: TweetMediaType
) {
  const url = directImageUrl(record);
  if (!url) {
    return;
  }

  const existing = seen.get(url);
  if (existing) {
    const expandedUrl = maybeExpandedUrl(record, url);
    const shortUrl = maybeShortUrl(record);
    if (!existing.expandedUrl && expandedUrl) {
      existing.expandedUrl = expandedUrl;
    }
    if (!existing.shortUrl && shortUrl) {
      existing.shortUrl = shortUrl;
    }
    if (existing.type === 'unknown') {
      existing.type = normalizeMediaType(record.type, hint);
    }
    return;
  }

  const item: TweetMediaItem = {
    type: normalizeMediaType(record.type ?? record.media_type ?? record.mediaType, hint),
    url
  };
  const expandedUrl = maybeExpandedUrl(record, url);
  const shortUrl = maybeShortUrl(record);
  if (expandedUrl) {
    item.expandedUrl = expandedUrl;
  }
  if (shortUrl) {
    item.shortUrl = shortUrl;
  }
  seen.set(url, item);
  items.push(item);
}

function collectMedia(
  value: unknown,
  items: TweetMediaItem[],
  seen: Map<string, TweetMediaItem>,
  hint?: TweetMediaType,
  depth = 0
) {
  if (depth > 5 || value == null) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectMedia(entry, items, seen, hint, depth + 1));
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  pushMedia(items, seen, value, hint);

  const groups: Array<[string, TweetMediaType]> = [
    ['photo', 'photo'],
    ['photos', 'photo'],
    ['image', 'photo'],
    ['images', 'photo'],
    ['video', 'video'],
    ['videos', 'video'],
    ['animated_gif', 'animated_gif'],
    ['animatedGif', 'animated_gif'],
    ['media', hint ?? 'unknown']
  ];
  for (const [key, groupHint] of groups) {
    if (key in value) {
      collectMedia(value[key], items, seen, groupHint, depth + 1);
    }
  }
}

export function extractTweetMedia(raw: unknown): TweetMediaItem[] {
  if (!isRecord(raw)) {
    return [];
  }

  const items: TweetMediaItem[] = [];
  const seen = new Map<string, TweetMediaItem>();
  collectMedia(raw.media, items, seen);
  collectMedia(isRecord(raw.entities) ? raw.entities.media : undefined, items, seen);
  collectMedia(isRecord(raw.extended_entities) ? raw.extended_entities.media : undefined, items, seen);
  collectMedia(isRecord(raw.extendedEntities) ? raw.extendedEntities.media : undefined, items, seen);
  collectMedia(isRecord(raw.includes) ? raw.includes.media : undefined, items, seen);
  collectMedia(isRecord(raw.attachments) ? raw.attachments.media : undefined, items, seen);
  return items;
}
