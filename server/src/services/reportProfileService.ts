import { Prisma } from '@prisma/client';
import { prisma } from '../db';

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
