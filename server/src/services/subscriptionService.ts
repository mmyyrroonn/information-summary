import { Prisma } from '@prisma/client';
import { prisma } from '../db';

export function normalizeScreenName(screenName: string) {
  return screenName.replace(/^@/, '').trim().toLowerCase();
}

export async function listSubscriptions() {
  return prisma.subscription.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function createSubscription(payload: { screenName: string; displayName?: string }) {
  const normalized = normalizeScreenName(payload.screenName);
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

export async function createSubscriptionIfNotExists(payload: {
  screenName: string;
  displayName?: string;
  avatarUrl?: string | null;
}) {
  const normalized = normalizeScreenName(payload.screenName);
  if (!normalized) {
    throw new Error('screenName is required');
  }

  try {
    const subscription = await prisma.subscription.create({
      data: {
        screenName: normalized,
        displayName: payload.displayName ?? null,
        avatarUrl: payload.avatarUrl ?? null
      }
    });
    return { subscription, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await prisma.subscription.findUnique({ where: { screenName: normalized } });
      if (!existing) {
        throw error;
      }
      return { subscription: existing, created: false };
    }
    throw error;
  }
}

export async function deleteSubscription(id: string) {
  return prisma.subscription.delete({ where: { id } });
}
