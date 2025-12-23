import { Prisma, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../db';

export function normalizeScreenName(screenName: string) {
  return screenName.replace(/^@/, '').trim().toLowerCase();
}

function normalizeTags(tags?: string[]) {
  if (!Array.isArray(tags)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  tags
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag) => Boolean(tag))
    .forEach((tag) => {
      if (seen.has(tag)) return;
      seen.add(tag);
      normalized.push(tag);
    });
  return normalized;
}

export async function listSubscriptions() {
  return prisma.subscription.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function createSubscription(payload: { screenName: string; displayName?: string; tags?: string[] }) {
  const normalized = normalizeScreenName(payload.screenName);
  if (!normalized) {
    throw new Error('screenName is required');
  }

  return prisma.subscription.create({
    data: {
      screenName: normalized,
      displayName: payload.displayName ?? null,
      tags: normalizeTags(payload.tags)
    }
  });
}

export async function createSubscriptionIfNotExists(payload: {
  screenName: string;
  displayName?: string;
  avatarUrl?: string | null;
  tags?: string[];
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
        avatarUrl: payload.avatarUrl ?? null,
        tags: normalizeTags(payload.tags)
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

export async function setSubscriptionStatus(id: string, status: SubscriptionStatus) {
  return prisma.subscription.update({
    where: { id },
    data: {
      status,
      unsubscribedAt: status === 'UNSUBSCRIBED' ? new Date() : null
    }
  });
}

export async function updateSubscription(
  id: string,
  payload: { status?: SubscriptionStatus; tags?: string[] }
) {
  const data: { status?: SubscriptionStatus; unsubscribedAt?: Date | null; tags?: string[] } = {};
  if (payload.status) {
    data.status = payload.status;
    data.unsubscribedAt = payload.status === 'UNSUBSCRIBED' ? new Date() : null;
  }
  if (payload.tags) {
    data.tags = normalizeTags(payload.tags);
  }
  return prisma.subscription.update({
    where: { id },
    data
  });
}
