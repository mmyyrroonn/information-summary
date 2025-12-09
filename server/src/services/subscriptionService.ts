import { prisma } from '../db';

export async function listSubscriptions() {
  return prisma.subscription.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function createSubscription(payload: { screenName: string; displayName?: string }) {
  const normalized = payload.screenName.replace(/^@/, '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('screenName is required');
  }

  return prisma.subscription.create({
    data: {
      screenName: normalized,
      displayName: payload.displayName ?? null
    }
  });
}

export async function deleteSubscription(id: string) {
  return prisma.subscription.delete({ where: { id } });
}
