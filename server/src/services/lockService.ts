import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { AiLockUnavailableError } from '../errors';

const AI_LOCK_KEY = 'ai-processing';

async function tryAcquireDistributedLock(key: string, holderId: string, ttlMs: number) {
  const now = new Date();
  const effectiveTtl = Math.max(60_000, ttlMs);
  const expiresAt = new Date(now.getTime() + effectiveTtl);
  const acquired = await prisma.$transaction(
    async (tx) => {
      const existing = await tx.systemLock.findUnique({
        where: { key }
      });
      if (!existing) {
        await tx.systemLock.create({
          data: {
            key,
            lockedBy: holderId,
            lockedAt: now,
            expiresAt
          }
        });
        return true;
      }
      if (!existing.lockedAt || !existing.expiresAt || existing.expiresAt <= now || existing.lockedBy === holderId) {
        await tx.systemLock.update({
          where: { key },
          data: {
            lockedBy: holderId,
            lockedAt: now,
            expiresAt
          }
        });
        return true;
      }
      return false;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  return acquired;
}

async function releaseDistributedLock(key: string, holderId: string) {
  await prisma.systemLock.updateMany({
    where: {
      key,
      lockedBy: holderId
    },
    data: {
      lockedAt: null,
      lockedBy: null,
      expiresAt: null
    }
  });
}

export async function withAiProcessingLock<T>(holderId: string, run: () => Promise<T>): Promise<T> {
  const lockTtl = config.AI_LOCK_TTL_MS;
  const acquired = await tryAcquireDistributedLock(AI_LOCK_KEY, holderId, lockTtl);
  if (!acquired) {
    logger.warn('AI processing lock unavailable', { holderId });
    throw new AiLockUnavailableError();
  }
  logger.info('AI processing lock acquired', { holderId, ttlMs: lockTtl });
  try {
    return await run();
  } finally {
    await releaseDistributedLock(AI_LOCK_KEY, holderId);
    logger.info('AI processing lock released', { holderId });
  }
}
