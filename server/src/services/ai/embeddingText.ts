import { truncateText } from './shared';

const URL_REGEX = /https?:\/\/\S+/gi;
const SHORT_URL_REGEX = /\bt\.co\/\S+/gi;
const PIC_URL_REGEX = /\bpic\.twitter\.com\/\S+/gi;
const RT_PREFIX_REGEX = /^rt\s+@[\w_]+:\s*/i;
const RT_ONLY_REGEX = /^rt\s+/i;
const MENTION_REGEX = /@[A-Za-z0-9_]+/g;
const HASHTAG_REGEX = /#([\p{L}\p{N}_]+)/gu;

export function normalizeEmbeddingText(raw: string) {
  if (!raw) return '';
  let text = raw;
  text = text.replace(RT_PREFIX_REGEX, '');
  text = text.replace(RT_ONLY_REGEX, '');
  text = text.replace(URL_REGEX, ' ');
  text = text.replace(SHORT_URL_REGEX, ' ');
  text = text.replace(PIC_URL_REGEX, ' ');
  text = text.replace(MENTION_REGEX, ' ');
  text = text.replace(HASHTAG_REGEX, '$1');
  text = text.replace(/\s+/g, ' ').trim();
  if (text) return text;
  const fallback = raw.replace(/\s+/g, ' ').trim();
  return fallback;
}

export function buildEmbeddingText(raw: string, maxLength: number, lang?: string | null) {
  const cleaned = normalizeEmbeddingText(raw);
  const langTag = typeof lang === 'string' ? lang.trim().toLowerCase() : '';
  const withLang = langTag ? `[lang:${langTag}] ${cleaned}` : cleaned;
  return truncateText(withLang, maxLength);
}
