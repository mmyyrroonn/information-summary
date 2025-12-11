import type { SystemLock } from '@prisma/client';
import { BackgroundJobStatus, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { AiLockUnavailableError } from '../errors';

const AI_LOCK_KEYS = {
  classify: 'ai-processing:classify',
  report: 'ai-processing:report'
} as const;
type AiProcessingLockScope = keyof typeof AI_LOCK_KEYS;
const DEFAULT_AI_LOCK_SCOPE: AiProcessingLockScope = 'classify';
const JOB_LOCK_PREFIX = 'job:';

interface LockRecoveryDecision {
  stale: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

function extractJobId(holderId: string | null) {
  if (!holderId || !holderId.startsWith(JOB_LOCK_PREFIX)) {
    return null;
  }
  const jobId = holderId.slice(JOB_LOCK_PREFIX.length);
  return jobId || null;
}

async function evaluateLockRecoverability(
  tx: Prisma.TransactionClient,
  lock: Pick<SystemLock, 'lockedBy' | 'lockedAt' | 'expiresAt'>,
  now: Date
): Promise<LockRecoveryDecision> {
  if (!lock.lockedBy || !lock.lockedAt || !lock.expiresAt) {
    return { stale: true, reason: 'missing-metadata' };
  }
  if (lock.expiresAt <= now) {
    return { stale: true, reason: 'expired' };
  }
  const jobId = extractJobId(lock.lockedBy);
  if (!jobId) {
    return { stale: false };
  }
  const job = await tx.backgroundJob.findUnique({
    where: { id: jobId },
    select: { status: true }
  });
  if (!job) {
    return { stale: true, reason: 'missing-job', details: { jobId } };
  }
  if (job.status !== BackgroundJobStatus.RUNNING) {
    return { stale: true, reason: 'inactive-job', details: { jobId, jobStatus: job.status } };
  }
  return { stale: false };
}

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
      const isSameHolder = existing.lockedBy === holderId;
      let recoverable: LockRecoveryDecision | null = null;
      if (!isSameHolder) {
        recoverable = await evaluateLockRecoverability(tx, existing, now);
      }
      if (isSameHolder || recoverable?.stale) {
        if (recoverable?.stale && !isSameHolder) {
          logger.warn('Recovering stale AI lock', {
            key,
            previousHolderId: existing.lockedBy,
            reason: recoverable.reason,
            ...(recoverable.details ?? {})
          });
        }
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

export async function withAiProcessingLock<T>(
  holderId: string,
  run: () => Promise<T>,
  options?: { scope?: AiProcessingLockScope }
): Promise<T> {
  const scope = options?.scope ?? DEFAULT_AI_LOCK_SCOPE;
  const lockKey = AI_LOCK_KEYS[scope];
  const lockTtl = config.AI_LOCK_TTL_MS;
  const acquired = await tryAcquireDistributedLock(lockKey, holderId, lockTtl);
  if (!acquired) {
    logger.warn('AI processing lock unavailable', { holderId, scope });
    throw new AiLockUnavailableError();
  }
  logger.info('AI processing lock acquired', { holderId, ttlMs: lockTtl, scope });
  try {
    return await run();
  } finally {
    await releaseDistributedLock(lockKey, holderId);
    logger.info('AI processing lock released', { holderId, scope });
  }
}
