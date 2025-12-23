import { prisma } from '../db';

interface ReportListOptions {
  limit?: number;
  profileId?: string;
}

export async function listReports(options: ReportListOptions = {}) {
  const query: {
    where?: { profileId: string };
    take: number;
  } = {
    take: options.limit ?? 20
  };
  if (options.profileId) {
    query.where = { profileId: options.profileId };
  }
  return prisma.report.findMany({
    ...query,
    select: {
      id: true,
      headline: true,
      periodStart: true,
      periodEnd: true,
      createdAt: true,
      deliveredAt: true,
      profileId: true
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getReport(id: string) {
  return prisma.report.findUnique({ where: { id } });
}
