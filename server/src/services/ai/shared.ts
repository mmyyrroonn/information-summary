export const TAG_FALLBACK_KEY = 'other';

// ── Domain + Tag 两级体系 ──────────────────────────────────────
export const DOMAINS = ['crypto', 'ai', 'finance'] as const;
export type Domain = (typeof DOMAINS)[number];

/** 跨领域通用 tag */
export const SHARED_TAGS = [
  'macro',
  'policy',
  'security',
  'funding',
  'tech',
  'trading',
  'narrative',
  TAG_FALLBACK_KEY
] as const;

/** 按领域分组的专属 tag */
export const DOMAIN_SPECIFIC_TAGS: Record<Domain, readonly string[]> = {
  crypto: ['yield', 'token', 'airdrop', 'onchain', 'exchange'],
  ai: ['model-release', 'ai-product', 'ai-company'],
  finance: ['equities', 'bonds', 'commodities', 'forex']
} as const;

/** 全量平铺 tag 列表（向后兼容） */
export const CLASSIFY_ALLOWED_TAGS = [
  ...SHARED_TAGS.filter((t) => t !== TAG_FALLBACK_KEY),
  ...DOMAIN_SPECIFIC_TAGS.crypto,
  ...DOMAIN_SPECIFIC_TAGS.ai,
  ...DOMAIN_SPECIFIC_TAGS.finance,
  TAG_FALLBACK_KEY
] as const;

const TAG_ALIASES: Record<string, string> = {
  market: 'macro',
  others: TAG_FALLBACK_KEY
};

export function normalizeTagAlias(tag: string) {
  return TAG_ALIASES[tag] ?? tag;
}

/** 获取某个领域可用的 tag 列表（专属 + 通用） */
export function getTagsForDomain(domain: Domain): string[] {
  const specific = DOMAIN_SPECIFIC_TAGS[domain] ?? [];
  return [...specific, ...SHARED_TAGS];
}

/** 根据 tag 列表推断最可能的领域 */
export function inferDomainFromTags(tags: string[]): Domain | null {
  if (!tags.length) return null;
  const scores: Record<Domain, number> = { crypto: 0, ai: 0, finance: 0 };
  for (const tag of tags) {
    for (const domain of DOMAINS) {
      if ((DOMAIN_SPECIFIC_TAGS[domain] as readonly string[]).includes(tag)) {
        scores[domain] += 1;
      }
    }
  }
  let best: Domain | null = null;
  let bestScore = 0;
  for (const domain of DOMAINS) {
    if (scores[domain] > bestScore) {
      bestScore = scores[domain];
      best = domain;
    }
  }
  return best;
}

export const DOMAIN_DISPLAY_NAMES: Record<Domain, string> = {
  crypto: '加密货币',
  ai: '人工智能',
  finance: '传统金融'
};

export const TAG_DISPLAY_NAMES: Record<string, string> = {
  // 通用
  policy: '政策 / 合规',
  macro: '宏观 / 行情',
  security: '安全 / 风险',
  funding: '融资 / 资金',
  tech: '技术 / 升级',
  trading: '交易机会',
  narrative: '叙事 / 主题',
  [TAG_FALLBACK_KEY]: '其他',
  // crypto 专属
  yield: '收益 / 理财',
  token: '代币 / 市场',
  airdrop: '空投 / 福利',
  onchain: '链上数据',
  exchange: '交易所 / 平台',
  // ai 专属
  'model-release': 'AI 模型发布',
  'ai-product': 'AI 产品/工具',
  'ai-company': 'AI 公司动态',
  // finance 专属
  equities: '股票 / 权益',
  bonds: '债券 / 固收',
  commodities: '大宗商品',
  forex: '外汇',
  // legacy aliases
  others: '其他',
  defi: 'DeFi',
  infrastructure: '基础设施',
  market: '宏观 / 行情',
  community: '社区 / 生态',
  governance: '治理',
  ecosystem: '生态升级'
};

export const HIGH_PRIORITY_IMPORTANCE = 4;

export function truncateText(text: string, maxLength = 160) {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  // Truncate by code points to avoid splitting surrogate pairs.
  const chars = Array.from(compact);
  if (chars.length <= maxLength) {
    return compact;
  }
  const sliceLength = Math.max(0, maxLength - 1);
  return `${chars.slice(0, sliceLength).join('')}…`;
}

export function delay(ms: number) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
) {
  if (!items.length) {
    return;
  }
  const poolSize = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;
  async function runNext(): Promise<void> {
    const current = nextIndex;
    if (current >= items.length) {
      return;
    }
    nextIndex += 1;
    const value = items[current];
    if (value === undefined) {
      return;
    }
    await worker(value, current);
    if (nextIndex < items.length) {
      await runNext();
    }
  }
  await Promise.all(Array.from({ length: poolSize }, () => runNext()));
}

export function getErrorMessage(error: unknown) {
  if (!error) {
    return 'unknown error';
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && 'message' in error && typeof (error as Record<string, unknown>).message === 'string') {
    return String((error as Record<string, unknown>).message);
  }
  return String(error);
}

export function isContentRiskMessage(message: string) {
  return message.toLowerCase().includes('content exists risk');
}

export function isServiceBusyMessage(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('503') || normalized.includes('service is too busy') || normalized.includes('too busy');
}
