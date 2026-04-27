/**
 * Bilibili PoC — verify UP-master video listing + video detail + dynamic feed.
 *
 * Run:
 *   cd server
 *   BILIBILI_TEST_MID=1629347259 \
 *     npx ts-node-dev --transpile-only src/services/sources/poc/bilibili.poc.ts
 *
 * Optional: BILIBILI_SESSDATA=xxx (logged-in cookie for higher rate limits / private content)
 *
 * What it tests:
 *   1. UP master video list — needs WBI-signed request (`/x/space/wbi/arc/search`)
 *   2. Video detail by bvid (`/x/web-interface/view`) — public, no auth
 *   3. Dynamic feed (`/x/polymer/web-dynamic/v1/feed/space`) — needs login cookie typically
 *   4. Print response shapes for field-mapping design
 *
 * Expected pitfalls:
 *   - 412 Precondition Failed (风控): try with proper UA + Referer
 *   - WBI signing: required for video list, optional for detail
 *   - Dynamic feed often requires SESSDATA
 */

import axios, { AxiosInstance } from 'axios';
import crypto from 'node:crypto';

const TEST_MID = process.env.BILIBILI_TEST_MID ?? '1629347259'; // 影视飓风 by default
const SESSDATA = process.env.BILIBILI_SESSDATA;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function buildClient(extraCookie = ''): AxiosInstance {
  const cookies: string[] = [];
  if (SESSDATA) cookies.push(`SESSDATA=${SESSDATA}`);
  if (extraCookie) cookies.push(extraCookie);

  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Referer': 'https://space.bilibili.com/',
    'Accept': 'application/json, text/plain, */*'
  };
  if (cookies.length > 0) {
    headers['Cookie'] = cookies.join('; ');
  }
  return axios.create({
    baseURL: 'https://api.bilibili.com',
    headers,
    timeout: 15000
  });
}

let client = buildClient();

// Generate bili_ticket — required by 风控 since 2024.
// Spec: https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/misc/sign/bili_ticket.md
async function genBiliTicket(): Promise<{ ticket: string; expires: number } | null> {
  const ts = Math.floor(Date.now() / 1000);
  const hexSign = crypto.createHmac('sha256', 'XgwSnGZ1p').update(`ts${ts}`).digest('hex');
  try {
    const { data } = await axios.post(
      'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket',
      null,
      {
        params: {
          key_id: 'ec02',
          hexsign: hexSign,
          'context[ts]': String(ts),
          csrf: ''
        },
        headers: {
          'User-Agent': UA,
          'Referer': 'https://www.bilibili.com/'
        },
        timeout: 10000
      }
    );
    if (data?.code === 0 && data?.data?.ticket) {
      return { ticket: data.data.ticket, expires: data.data.created_at + data.data.ttl };
    }
    console.error('  bili_ticket gen failed:', data?.code, data?.message);
    return null;
  } catch (err: any) {
    console.error('  bili_ticket request error:', err.message);
    return null;
  }
}

// Anonymous access since 2024 needs full anonymous fingerprint cookies.
// Strategy: visit www.bilibili.com first, capture all Set-Cookie headers, replay them.
async function bootstrapAnonCookies(): Promise<string> {
  const homepage = await axios.get('https://www.bilibili.com/', {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    timeout: 10000,
    validateStatus: () => true
  });
  const setCookies = homepage.headers['set-cookie'] ?? [];
  console.log(`  → homepage status ${homepage.status}, ${setCookies.length} Set-Cookie headers`);
  const cookieParts = setCookies
    .map((c: string) => c.split(';')[0]!.trim())
    .filter((c) => c.length > 0 && c.includes('='));
  // Also explicitly fetch SPI buvid3/4 (some are HttpOnly and not in Set-Cookie depending on edge)
  try {
    const spi = await axios.get('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' }
    });
    if (spi.data?.data?.b_3) cookieParts.push(`buvid3=${spi.data.data.b_3}`);
    if (spi.data?.data?.b_4) cookieParts.push(`buvid4=${spi.data.data.b_4}`);
  } catch {
    /* ignore */
  }
  // Note: tried adding generated b_lsid/_uuid but it triggers more aggressive bot detection (-412 banned)
  // when format doesn't match real browser output. Stick to what we can fetch from the server.
  cookieParts.push(`b_nut=${Math.floor(Date.now() / 1000)}`);
  const cookie = cookieParts.join('; ');
  console.log(`  → captured cookies: ${cookieParts.map((c) => c.split('=')[0]).join(', ')}`);
  return cookie;
}

// ----- WBI signing -----
// Spec: https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/misc/sign/wbi.md
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

function getMixinKey(orig: string): string {
  return MIXIN_KEY_ENC_TAB.map((idx) => orig[idx] ?? '').join('').slice(0, 32);
}

interface NavWbiKeys {
  imgKey: string;
  subKey: string;
}

let cachedNavKeys: NavWbiKeys | null = null;

async function getWbiKeys(): Promise<NavWbiKeys> {
  if (cachedNavKeys) return cachedNavKeys;
  const { data } = await client.get('/x/web-interface/nav');
  // nav returns -101 (not logged in) but still includes wbi_img keys
  const wbi = data?.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) {
    throw new Error(`Failed to get WBI keys, response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const imgKey = wbi.img_url.split('/').pop().split('.')[0];
  const subKey = wbi.sub_url.split('/').pop().split('.')[0];
  cachedNavKeys = { imgKey, subKey };
  return cachedNavKeys;
}

function buildSignedQueryString(params: Record<string, string>, mixinKey: string): string {
  const sortedKeys = Object.keys(params).sort();
  const sanitized: Record<string, string> = {};
  for (const k of sortedKeys) {
    sanitized[k] = params[k]!.replace(/[!'()*]/g, '');
  }
  const query = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(sanitized[k]!)}`)
    .join('&');
  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

async function signWbiQueryString(params: Record<string, string | number>): Promise<string> {
  const { imgKey, subKey } = await getWbiKeys();
  const mixinKey = getMixinKey(imgKey + subKey);
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    merged[k] = String(v);
  }
  merged.wts = String(Math.floor(Date.now() / 1000));
  return buildSignedQueryString(merged, mixinKey);
}

// ----- API calls -----

async function fetchUpVideoList(mid: string, pageSize = 5) {
  // dm_* params are anti-bot fingerprint; values from a real browser session.
  const queryString = await signWbiQueryString({
    mid,
    ps: pageSize,
    pn: 1,
    order: 'pubdate',
    platform: 'web',
    web_location: 1550101,
    dm_img_list: '[]',
    dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
    dm_cover_img_str:
      'QU5HTEUgKEFwcGxlLCBBcHBsZSBNMSBQcm8sIE9wZW5HTCA0LjEgTWV0YWwgLSAzMjMuMTApT3BlbkdMIDQuMSBBcHBsZS1NMSBQcm8',
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}'
  });
  // Pass the signed query string directly to bypass axios's params serializer
  const { data } = await client.get(`/x/space/wbi/arc/search?${queryString}`, {
    headers: { Referer: `https://space.bilibili.com/${mid}/upload/video` }
  });
  return data;
}

async function fetchVideoDetail(bvid: string) {
  const { data } = await client.get('/x/web-interface/view', { params: { bvid } });
  return data;
}

async function fetchDynamicFeed(mid: string) {
  const { data } = await client.get('/x/polymer/web-dynamic/v1/feed/space', {
    params: {
      offset: '',
      host_mid: mid,
      timezone_offset: -480,
      platform: 'web',
      features: 'itemOpusStyle'
    }
  });
  return data;
}

function summarizeVideoListItem(v: any) {
  return {
    bvid: v.bvid,
    aid: v.aid,
    title: v.title,
    description: v.description?.slice(0, 200),
    descriptionLength: v.description?.length ?? 0,
    pubdate: v.created ? new Date(v.created * 1000).toISOString() : undefined,
    duration: v.length,
    pic: v.pic,
    play: v.play,
    comment: v.comment,
    videoReview: v.video_review,
    typename: v.typename
  };
}

function summarizeDetail(v: any) {
  return {
    bvid: v.bvid,
    aid: v.aid,
    title: v.title,
    desc: v.desc?.slice(0, 300),
    descLength: v.desc?.length ?? 0,
    pubdate: v.pubdate ? new Date(v.pubdate * 1000).toISOString() : undefined,
    duration: v.duration,
    owner: v.owner,
    stat: v.stat,
    videos: v.videos,
    pages: Array.isArray(v.pages) ? v.pages.length : 0
  };
}

function summarizeDynamic(items: any[]) {
  return items.slice(0, 3).map((item) => ({
    type: item.type,
    id_str: item.id_str,
    pub_time: item.modules?.module_author?.pub_time,
    pub_ts: item.modules?.module_author?.pub_ts
      ? new Date(item.modules.module_author.pub_ts * 1000).toISOString()
      : undefined,
    name: item.modules?.module_author?.name,
    text: item.modules?.module_dynamic?.desc?.text?.slice(0, 200) ??
      item.modules?.module_dynamic?.major?.opus?.summary?.text?.slice(0, 200) ??
      item.modules?.module_dynamic?.major?.archive?.title,
    has_archive: Boolean(item.modules?.module_dynamic?.major?.archive)
  }));
}

async function main() {
  console.log(`\n=== Bilibili PoC ===`);
  console.log(`UP mid: ${TEST_MID}`);
  console.log(`SESSDATA provided: ${Boolean(SESSDATA)}\n`);

  const startedAt = Date.now();

  console.log('[0/3] Bootstrapping anon cookies + bili_ticket...');
  try {
    const anonCookie = await bootstrapAnonCookies();
    const ticket = await genBiliTicket();
    let fullCookie = anonCookie;
    if (ticket) {
      fullCookie += `; bili_ticket=${ticket.ticket}; bili_ticket_expires=${ticket.expires}`;
      console.log('  → bili_ticket acquired, expires:', new Date(ticket.expires * 1000).toISOString());
    } else {
      console.log('  → bili_ticket unavailable, continuing without');
    }
    client = buildClient(fullCookie);
  } catch (err: any) {
    console.error('  bootstrap failed:', err.message);
  }

  console.log('\n[1/3] Fetching UP video list (WBI-signed)...');
  try {
    const list = await fetchUpVideoList(TEST_MID, 5);
    console.log('  code:', list.code, 'message:', list.message);
    const videos = list.data?.list?.vlist ?? [];
    console.log(`  Got ${videos.length} videos`);
    videos.slice(0, 3).forEach((v: any, i: number) => {
      console.log(`\n  Video ${i + 1}:`, summarizeVideoListItem(v));
    });

    if (videos.length > 0) {
      console.log('\n[2/3] Fetching video detail by bvid...');
      const bvid = videos[0].bvid;
      const detail = await fetchVideoDetail(bvid);
      console.log('  code:', detail.code, 'message:', detail.message);
      if (detail.data) {
        console.log('  detail:', summarizeDetail(detail.data));
      }
    }
  } catch (err: any) {
    console.error('  FAILED:', err.response?.status, err.response?.data ?? err.message);
  }

  console.log('\n[3/3] Fetching dynamic feed (often needs SESSDATA)...');
  try {
    const dyn = await fetchDynamicFeed(TEST_MID);
    console.log('  code:', dyn.code, 'message:', dyn.message);
    const items = dyn.data?.items ?? [];
    console.log(`  Got ${items.length} dynamic items`);
    if (items.length > 0) {
      console.log('  samples:', summarizeDynamic(items));
    }
  } catch (err: any) {
    console.error('  FAILED:', err.response?.status, err.response?.data ?? err.message);
  }

  console.log('\n=== Summary ===');
  console.log('Elapsed:', `${Date.now() - startedAt}ms`);
  console.log('Notes:');
  console.log('  - Video list endpoint REQUIRES wbi signing (or returns -352)');
  console.log('  - Detail endpoint is public (no auth, no wbi)');
  console.log('  - Dynamic feed may return -352 / -401 without SESSDATA');
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
