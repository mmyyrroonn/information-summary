import { BackgroundJob, BackgroundJobStatus, Prisma } from '@prisma/client';
import { prisma } from '../db';
import { BackgroundJobType } from '../jobs/jobQueue';

export interface JobFilter {
  type?: BackgroundJobType;
  status?: BackgroundJobStatus;
  limit?: number;
}

export interface JobSummary {
  id: string;
  type: string;
  status: BackgroundJobStatus;
  attempts: number;
  maxAttempts: number;
  scheduledAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  completedAt: Date | null;
  lastError: string | null;
  payload: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeJob(job: BackgroundJob): JobSummary {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    scheduledAt: job.scheduledAt,
    lockedAt: job.lockedAt,
    lockedBy: job.lockedBy,
    completedAt: job.completedAt,
    lastError: job.lastError,
    payload: job.payload,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

export async function listJobs(filter: JobFilter = {}) {
  const where: Prisma.BackgroundJobWhereInput = {};
  if (filter.type) {
    where.type = filter.type;
  }
  if (filter.status) {
    where.status = filter.status;
  }
  const jobs = await prisma.backgroundJob.findMany({
    where,
    orderBy: {
      scheduledAt: 'desc'
    },
    take: filter.limit ?? 20
  });

  return jobs.map(serializeJob);
}

export async function getJobById(id: string) {
  const job = await prisma.backgroundJob.findUnique({
    where: { id }
  });
  return job ? serializeJob(job) : null;
}
