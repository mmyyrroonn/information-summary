import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';

const DEFAULT_REPORT_PROFILE_NAME = '默认日报';
const DEFAULT_REPORT_PROFILE_CRON = '0 9 * * *';
const DEFAULT_REPORT_PROFILE_WINDOW_HOURS = 24;

const US_STOCK_REPORT_PROFILE_NAME = '美股日报';
const US_STOCK_REPORT_PROFILE_CRON = '0 20 * * 1-5'; // 周一至周五晚8点（北京时间，对应美东开盘前）
const US_STOCK_REPORT_PROFILE_WINDOW_HOURS = 24;

export async function listReportProfiles() {
  return prisma.reportProfile.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function listEnabledReportProfiles() {
  return prisma.reportProfile.findMany({ where: { enabled: true } });
}

export async function getReportProfile(id: string) {
  return prisma.reportProfile.findUnique({ where: { id } });
}

export async function createReportProfile(data: Prisma.ReportProfileCreateInput) {
  return prisma.reportProfile.create({ data });
}

export async function updateReportProfile(id: string, data: Prisma.ReportProfileUpdateInput) {
  return prisma.reportProfile.update({ where: { id }, data });
}

export async function deleteReportProfile(id: string) {
  return prisma.reportProfile.delete({ where: { id } });
}

export async function getOrCreateDefaultReportProfile() {
  const existing = await prisma.reportProfile.findFirst({
    where: { name: DEFAULT_REPORT_PROFILE_NAME },
    orderBy: { createdAt: 'desc' }
  });
  if (existing) {
    return existing;
  }
  return prisma.reportProfile.create({
    data: {
      name: DEFAULT_REPORT_PROFILE_NAME,
      enabled: true,
      scheduleCron: DEFAULT_REPORT_PROFILE_CRON,
      windowHours: DEFAULT_REPORT_PROFILE_WINDOW_HOURS,
      timezone: config.REPORT_TIMEZONE,
      includeTweetTags: [],
      excludeTweetTags: [],
      includeAuthorTags: [],
      excludeAuthorTags: [],
      minImportance: config.REPORT_MIN_IMPORTANCE,
      verdicts: [],
      groupBy: 'cluster',
      aiFilterEnabled: config.REPORT_MID_TRIAGE_ENABLED,
      aiFilterPrompt: null,
      aiFilterMaxKeepPerChunk: null
    }
  });
}

export async function getOrCreateUsStockReportProfile() {
  const existing = await prisma.reportProfile.findFirst({
    where: { name: US_STOCK_REPORT_PROFILE_NAME },
    orderBy: { createdAt: 'desc' }
  });
  if (existing) {
    return existing;
  }
  return prisma.reportProfile.create({
    data: {
      name: US_STOCK_REPORT_PROFILE_NAME,
      enabled: true,
      scheduleCron: US_STOCK_REPORT_PROFILE_CRON,
      windowHours: US_STOCK_REPORT_PROFILE_WINDOW_HOURS,
      timezone: config.REPORT_TIMEZONE,
      includeTweetTags: ['equities', 'bonds', 'commodities', 'forex', 'macro', 'policy', 'funding', 'trading'],
      excludeTweetTags: [],
      includeAuthorTags: [],
      excludeAuthorTags: [],
      domains: ['finance'],
      minImportance: 2,
      verdicts: [],
      groupBy: 'cluster',
      aiFilterEnabled: true,
      aiFilterPrompt: '专注美股/港股/中概股相关内容，优先保留：财报数据、机构评级、并购IPO、宏观经济数据、央行政策、行业政策(关税/制裁)。过滤纯加密货币/DeFi内容。',
      aiFilterMaxKeepPerChunk: null
    }
  });
}
