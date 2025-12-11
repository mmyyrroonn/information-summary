import { BackgroundJob, BackgroundJobStatus, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { logger } from '../logger';

export type BackgroundJobType = 'fetch-subscriptions' | 'classify-tweets' | 'report-pipeline';

export interface JobPayloadMap {
  'fetch-subscriptions': {
    limit?: number;
    force?: boolean;
  };
  'classify-tweets': {
    source?: string;
    force?: boolean;
    minPending?: number;
    pendingCount?: number;
  };
  'report-pipeline': {
    notify?: boolean;
    trigger?: string;
  };
}

const ACTIVE_STATUSES: BackgroundJobStatus[] = [BackgroundJobStatus.PENDING, BackgroundJobStatus.RUNNING];

export interface EnqueueJobOptions {
  runAt?: Date;
  maxAttempts?: number;
  dedupe?: boolean;
}

export type QueuedJob<T extends BackgroundJobType = BackgroundJobType> = BackgroundJob & {
  type: T;
  payload: JobPayloadMap[T] | null;
};

function toJsonValue(payload: unknown): Prisma.InputJsonValue | undefined {
  if (payload === undefined) {
    return undefined;
  }
  return payload as Prisma.InputJsonValue;
}

function parsePayload<T>(payload: Prisma.JsonValue | null): T | null {
  if (!payload) return null;
  return payload as T;
}

export interface EnqueueResult {
  job: BackgroundJob;
  created: boolean;
}

export async function enqueueJob<T extends BackgroundJobType>(
  type: T,
  payload: JobPayloadMap[T],
  options?: EnqueueJobOptions
): Promise<EnqueueResult> {
  if (options?.dedupe) {
    const existing = await prisma.backgroundJob.findFirst({
      where: {
        type,
        status: { in: ACTIVE_STATUSES }
      },
      orderBy: {
        scheduledAt: 'asc'
      }
    });
    if (existing) {
      logger.info('Job already active, skipping enqueue', { type, jobId: existing.id });
      return { job: existing, created: false };
    }
  }

  const serializedPayload = toJsonValue(payload);
  const data: Prisma.BackgroundJobCreateInput = {
    type,
    scheduledAt: options?.runAt ?? new Date(),
    maxAttempts: options?.maxAttempts ?? 3
  };
  if (serializedPayload !== undefined) {
    data.payload = serializedPayload;
  }

  const job = await prisma.backgroundJob.create({ data });
  return { job, created: true };
}

export async function reserveNextJob(workerId: string): Promise<QueuedJob | null> {
  const now = new Date();
  while (true) {
    const pending = await prisma.backgroundJob.findFirst({
      where: {
        status: BackgroundJobStatus.PENDING,
        scheduledAt: { lte: now }
      },
      orderBy: {
        scheduledAt: 'asc'
      }
    });

    if (!pending) {
      return null;
    }

    const lockedAt = new Date();
    const updated = await prisma.backgroundJob.updateMany({
      where: {
        id: pending.id,
        status: BackgroundJobStatus.PENDING
      },
      data: {
        status: BackgroundJobStatus.RUNNING,
        lockedAt,
        lockedBy: workerId,
        attempts: pending.attempts + 1
      }
    });

    if (updated.count === 0) {
      continue;
    }

    return {
      ...pending,
      status: BackgroundJobStatus.RUNNING,
      lockedAt,
      lockedBy: workerId,
      attempts: pending.attempts + 1,
      payload: parsePayload(pending.payload)
    } as QueuedJob;
  }
}

export async function markJobComplete(jobId: string) {
  await prisma.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: BackgroundJobStatus.COMPLETED,
      completedAt: new Date(),
      lockedAt: null,
      lockedBy: null
    }
  });
}

export async function markJobFailed(job: QueuedJob, error: unknown, options?: { retryDelayMs?: number }) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const retryDelay = options?.retryDelayMs ?? 5000;
  const shouldRetry = job.attempts < job.maxAttempts;

  if (!shouldRetry) {
    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: {
        status: BackgroundJobStatus.FAILED,
        lastError: errorMessage,
        lockedAt: null,
        lockedBy: null
      }
    });
    logger.error('Background job permanently failed', { jobId: job.id, type: job.type, error: errorMessage });
    return;
  }

  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: {
      status: BackgroundJobStatus.PENDING,
      scheduledAt: new Date(Date.now() + retryDelay),
      lockedAt: null,
      lockedBy: null,
      lastError: errorMessage
    }
  });
  logger.warn('Background job failed, scheduled for retry', {
    jobId: job.id,
    type: job.type,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: errorMessage
  });
}

export async function requeueJob(job: QueuedJob, options?: { delayMs?: number; revertAttempt?: boolean }) {
  const delayMs = options?.delayMs ?? 2000;
  const data: Prisma.BackgroundJobUpdateInput = {
    status: BackgroundJobStatus.PENDING,
    scheduledAt: new Date(Date.now() + delayMs),
    lockedAt: null,
    lockedBy: null
  };
  if (options?.revertAttempt && job.attempts > 0) {
    data.attempts = { decrement: 1 };
  }
  await prisma.backgroundJob.update({
    where: { id: job.id },
    data
  });
}
