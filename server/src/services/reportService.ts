import { prisma } from '../db';

export async function listReports(limit = 20) {
  return prisma.report.findMany({
    select: {
      id: true,
      headline: true,
      periodStart: true,
      periodEnd: true,
      createdAt: true,
      deliveredAt: true
    },
    orderBy: { createdAt: 'desc' },
    take: limit
  });
}

export async function getReport(id: string) {
  return prisma.report.findUnique({ where: { id } });
}
