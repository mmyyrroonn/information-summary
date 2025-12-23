import { Router } from 'express';
import cron from 'node-cron';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { config } from '../config';
import {
  createReportProfile,
  deleteReportProfile,
  getReportProfile,
  listReportProfiles,
  updateReportProfile
} from '../services/reportProfileService';
import { enqueueJob } from '../jobs/jobQueue';
import { serializeJob } from '../services/jobService';

const router = Router();

const verdictSchema = z.enum(['ignore', 'watch', 'actionable']);
const groupBySchema = z.enum(['cluster', 'tag', 'author']);
const cronSchema = z.string().min(1).refine((value) => cron.validate(value), { message: 'Invalid cron expression' });

function normalizeStringList(input?: string[]) {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const values: string[] = [];
  input
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => Boolean(entry))
    .forEach((entry) => {
      if (seen.has(entry)) return;
      seen.add(entry);
      values.push(entry);
    });
  return values;
}

function normalizePrompt(input?: string | null) {
  if (input === null || input === undefined) {
    return null;
  }
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

const profileCreateSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  scheduleCron: cronSchema,
  windowHours: z.number().int().positive(),
  timezone: z.string().min(1).optional(),
  includeTweetTags: z.array(z.string()).optional(),
  excludeTweetTags: z.array(z.string()).optional(),
  includeAuthorTags: z.array(z.string()).optional(),
  excludeAuthorTags: z.array(z.string()).optional(),
  minImportance: z.number().int().min(1).max(5).optional(),
  verdicts: z.array(verdictSchema).optional(),
  groupBy: groupBySchema.optional(),
  aiFilterEnabled: z.boolean().optional(),
  aiFilterPrompt: z.string().optional().nullable(),
  aiFilterMaxKeepPerChunk: z.number().int().positive().optional()
});

const profileUpdateSchema = profileCreateSchema.partial();

router.get('/', async (_req, res, next) => {
  try {
    const profiles = await listReportProfiles();
    res.json(profiles);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const profile = await getReportProfile(params.id);
    if (!profile) {
      res.status(404).json({ message: 'Report profile not found' });
      return;
    }
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = profileCreateSchema.parse(req.body ?? {});
    const profile = await createReportProfile({
      name: body.name.trim(),
      enabled: body.enabled ?? true,
      scheduleCron: body.scheduleCron.trim(),
      windowHours: body.windowHours,
      timezone: body.timezone?.trim() || config.REPORT_TIMEZONE,
      includeTweetTags: normalizeStringList(body.includeTweetTags),
      excludeTweetTags: normalizeStringList(body.excludeTweetTags),
      includeAuthorTags: normalizeStringList(body.includeAuthorTags),
      excludeAuthorTags: normalizeStringList(body.excludeAuthorTags),
      minImportance: body.minImportance ?? config.REPORT_MIN_IMPORTANCE,
      verdicts: normalizeStringList(body.verdicts),
      groupBy: body.groupBy ?? 'cluster',
      aiFilterEnabled: body.aiFilterEnabled ?? true,
      aiFilterPrompt: normalizePrompt(body.aiFilterPrompt),
      aiFilterMaxKeepPerChunk: body.aiFilterMaxKeepPerChunk ?? null
    });
    res.status(201).json(profile);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = profileUpdateSchema.parse(req.body ?? {});
    const data: Prisma.ReportProfileUpdateInput = {};
    if (body.name !== undefined) {
      data.name = body.name.trim();
    }
    if (body.enabled !== undefined) {
      data.enabled = body.enabled;
    }
    if (body.scheduleCron !== undefined) {
      data.scheduleCron = body.scheduleCron.trim();
    }
    if (body.windowHours !== undefined) {
      data.windowHours = body.windowHours;
    }
    if (body.timezone !== undefined) {
      data.timezone = body.timezone.trim();
    }
    if (body.includeTweetTags !== undefined) {
      data.includeTweetTags = normalizeStringList(body.includeTweetTags);
    }
    if (body.excludeTweetTags !== undefined) {
      data.excludeTweetTags = normalizeStringList(body.excludeTweetTags);
    }
    if (body.includeAuthorTags !== undefined) {
      data.includeAuthorTags = normalizeStringList(body.includeAuthorTags);
    }
    if (body.excludeAuthorTags !== undefined) {
      data.excludeAuthorTags = normalizeStringList(body.excludeAuthorTags);
    }
    if (body.minImportance !== undefined) {
      data.minImportance = body.minImportance;
    }
    if (body.verdicts !== undefined) {
      data.verdicts = normalizeStringList(body.verdicts);
    }
    if (body.groupBy !== undefined) {
      data.groupBy = body.groupBy;
    }
    if (body.aiFilterEnabled !== undefined) {
      data.aiFilterEnabled = body.aiFilterEnabled;
    }
    if (body.aiFilterPrompt !== undefined) {
      data.aiFilterPrompt = normalizePrompt(body.aiFilterPrompt);
    }
    if (body.aiFilterMaxKeepPerChunk !== undefined) {
      data.aiFilterMaxKeepPerChunk = body.aiFilterMaxKeepPerChunk;
    }
    const updated = await updateReportProfile(params.id, data);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    await deleteReportProfile(params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.post('/:id/run', async (req, res, next) => {
  try {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        notify: z.boolean().optional()
      })
      .parse(req.body ?? {});
    const payload = {
      profileId: params.id,
      notify: body.notify ?? true,
      trigger: 'manual',
      windowEnd: new Date().toISOString()
    };
    const { job, created } = await enqueueJob('report-profile', payload, { dedupe: false });
    res.status(created ? 202 : 200).json({
      created,
      job: serializeJob(job),
      notify: payload.notify
    });
  } catch (error) {
    next(error);
  }
});

export default router;
