import { prisma } from '../db';

export async function listReports(limit = 20) {
  return prisma.report.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit
  });
}

export async function getReport(id: string) {
  return prisma.report.findUnique({ where: { id } });
}
