import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';

const DEFAULT_REPORT_PROFILE_NAME = '默认日报';
const DEFAULT_REPORT_PROFILE_CRON = '0 9 * * *';
const DEFAULT_REPORT_PROFILE_WINDOW_HOURS = 24;

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
