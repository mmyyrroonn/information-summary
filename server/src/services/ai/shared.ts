export const TAG_FALLBACK_KEY = 'other';

export const TAG_DISPLAY_NAMES: Record<string, string> = {
  policy: '政策 / 合规',
  macro: '宏观 / 行情',
  security: '安全 / 风险',
  funding: '融资 / 资金',
  yield: '收益 / 理财',
  token: '代币 / 市场',
  airdrop: '空投 / 福利',
  trading: '交易机会',
  onchain: '链上数据',
  tech: '技术 / 升级',
  exchange: '交易所 / 平台',
  narrative: '叙事 / 主题',
  [TAG_FALLBACK_KEY]: '其他',
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
  return `${compact.slice(0, maxLength - 1)}…`;
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
