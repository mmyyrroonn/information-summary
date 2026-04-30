import { Prisma, SourcePlatform, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { fetchTweets } from './ingestService';
import { createSubscriptionIfNotExists, normalizeScreenName } from './subscriptionService';
import { normalizeSourceIdentifier, selectDueSources } from './sourceListPolicy';

export type SourceListFetchResult = {
  sourceId: string;
  platform: SourcePlatform;
  identifier: string;
  processed: number;
  inserted: number;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

function normalizeTags(tags?: string[]) {
  if (!Array.isArray(tags)) {
    return [];
  }
  const seen = new Set<string>();
  const values: string[] = [];
  tags
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .forEach((tag) => {
      if (seen.has(tag)) return;
      seen.add(tag);
      values.push(tag);
    });
  return values;
}

export async function listSourceLists() {
  return prisma.sourceList.findMany({
    include: { _count: { select: { sources: true, reportProfiles: true } } },
    orderBy: { createdAt: 'desc' }
  });
}

export async function listEnabledSourceLists() {
  return prisma.sourceList.findMany({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
}

export async function getSourceList(id: string) {
  return prisma.sourceList.findUnique({
    where: { id },
    include: { sources: { orderBy: { createdAt: 'desc' } } }
  });
}

export async function createSourceList(data: {
  name: string;
  description?: string | null | undefined;
  enabled?: boolean | undefined;
  scheduleCron?: string | undefined;
  batchSize?: number | undefined;
  sourceCooldownHours?: number | undefined;
}) {
  return prisma.sourceList.create({
    data: {
      name: data.name.trim(),
      description: data.description?.trim() || null,
      enabled: data.enabled ?? true,
      scheduleCron: data.scheduleCron?.trim() || config.SOURCE_LIST_FETCH_CRON_SCHEDULE,
      batchSize: data.batchSize ?? config.SOURCE_LIST_FETCH_BATCH_SIZE,
      sourceCooldownHours: data.sourceCooldownHours ?? config.SOURCE_LIST_SOURCE_COOLDOWN_HOURS
    }
  });
}

export async function updateSourceList(
  id: string,
  data: {
    name?: string | undefined;
    description?: string | null | undefined;
    enabled?: boolean | undefined;
    scheduleCron?: string | undefined;
    batchSize?: number | undefined;
    sourceCooldownHours?: number | undefined;
  }
) {
  const update: Prisma.SourceListUpdateInput = {};
  if (data.name !== undefined) update.name = data.name.trim();
  if (data.description !== undefined) update.description = data.description?.trim() || null;
  if (data.enabled !== undefined) update.enabled = data.enabled;
  if (data.scheduleCron !== undefined) update.scheduleCron = data.scheduleCron.trim();
  if (data.batchSize !== undefined) update.batchSize = data.batchSize;
  if (data.sourceCooldownHours !== undefined) update.sourceCooldownHours = data.sourceCooldownHours;
  return prisma.sourceList.update({ where: { id }, data: update });
}

export async function deleteSourceList(id: string) {
  return prisma.sourceList.delete({ where: { id } });
}

export async function listSources(listId: string) {
  return prisma.source.findMany({ where: { listId }, orderBy: { createdAt: 'desc' } });
}

export async function upsertSource(data: {
  listId: string;
  platform: SourcePlatform;
  identifier: string;
  displayName?: string | null | undefined;
  url?: string | null | undefined;
  tags?: string[] | undefined;
  enabled?: boolean | undefined;
  subscriptionId?: string | null | undefined;
}) {
  const identifier = normalizeSourceIdentifier(data.platform, data.identifier);
  if (!identifier) {
    throw new Error('identifier is required');
  }
  const subscriptionId =
    data.platform === SourcePlatform.TWITTER
      ? await resolveTwitterSubscriptionId(identifier, data.displayName ?? undefined, data.tags, data.subscriptionId)
      : data.subscriptionId ?? null;

  return prisma.source.upsert({
    where: {
      listId_platform_identifier: {
        listId: data.listId,
        platform: data.platform,
        identifier
      }
    },
    update: {
      displayName: data.displayName?.trim() || null,
      url: data.url?.trim() || null,
      tags: normalizeTags(data.tags),
      enabled: data.enabled ?? true,
      subscriptionId
    },
    create: {
      listId: data.listId,
      platform: data.platform,
      identifier,
      displayName: data.displayName?.trim() || null,
      url: data.url?.trim() || null,
      tags: normalizeTags(data.tags),
      enabled: data.enabled ?? true,
      subscriptionId
    }
  });
}

export async function updateSource(
  id: string,
  data: {
    displayName?: string | null | undefined;
    url?: string | null | undefined;
    tags?: string[] | undefined;
    enabled?: boolean | undefined;
  }
) {
  const update: Prisma.SourceUpdateInput = {};
  if (data.displayName !== undefined) update.displayName = data.displayName?.trim() || null;
  if (data.url !== undefined) update.url = data.url?.trim() || null;
  if (data.tags !== undefined) update.tags = normalizeTags(data.tags);
  if (data.enabled !== undefined) update.enabled = data.enabled;
  return prisma.source.update({ where: { id }, data: update });
}

export async function deleteSource(id: string) {
  return prisma.source.delete({ where: { id } });
}

async function resolveTwitterSubscriptionId(
  identifier: string,
  displayName?: string,
  tags?: string[],
  requestedSubscriptionId?: string | null
) {
  if (requestedSubscriptionId) {
    return requestedSubscriptionId;
  }
  const normalized = normalizeScreenName(identifier);
  const payload: { screenName: string; displayName?: string; tags?: string[] } = { screenName: normalized };
  if (displayName) {
    payload.displayName = displayName;
  }
  if (tags) {
    payload.tags = tags;
  }
  const { subscription } = await createSubscriptionIfNotExists(payload);
  return subscription.id;
}

export async function importSubscriptionsToSourceList(
  listId: string,
  options: {
    subscriptionIds?: string[] | undefined;
    screenNames?: string[] | undefined;
    tags?: string[] | undefined;
    status?: SubscriptionStatus | undefined;
    pauseUnlisted?: boolean | undefined;
    dryRun?: boolean | undefined;
  }
) {
  const normalizedNames = (options.screenNames ?? []).map(normalizeScreenName).filter(Boolean);
  const normalizedTags = normalizeTags(options.tags);
  const where: Prisma.SubscriptionWhereInput = {};
  const or: Prisma.SubscriptionWhereInput[] = [];
  if (options.subscriptionIds?.length) {
    or.push({ id: { in: options.subscriptionIds } });
  }
  if (normalizedNames.length) {
    or.push({ screenName: { in: normalizedNames } });
  }
  if (normalizedTags.length) {
    or.push({ tags: { hasSome: normalizedTags } });
  }
  if (or.length) {
    where.OR = or;
  }
  if (options.status) {
    where.status = options.status;
  }

  const subscriptions = await prisma.subscription.findMany({ where, orderBy: { screenName: 'asc' } });
  if (options.dryRun) {
    const pausePreview = options.pauseUnlisted ? await previewPauseUnlistedTwitterSubscriptions() : null;
    return {
      dryRun: true,
      imported: 0,
      matched: subscriptions.length,
      paused: 0,
      pauseCandidates: pausePreview?.count ?? 0,
      subscriptions
    };
  }

  let imported = 0;
  for (const subscription of subscriptions) {
    const sourcePayload: Parameters<typeof upsertSource>[0] = {
      listId,
      platform: SourcePlatform.TWITTER,
      identifier: subscription.screenName,
      tags: subscription.tags,
      subscriptionId: subscription.id
    };
    if (subscription.displayName) {
      sourcePayload.displayName = subscription.displayName;
    }
    await upsertSource(sourcePayload);
    imported += 1;
  }

  const paused = options.pauseUnlisted ? (await pauseUnlistedTwitterSubscriptions()).updated : 0;
  return {
    dryRun: false,
    imported,
    matched: subscriptions.length,
    paused,
    subscriptions
  };
}

async function previewPauseUnlistedTwitterSubscriptions() {
  const whitelistIds = await getWhitelistedTwitterSubscriptionIds();
  return prisma.subscription.count({
    where: {
      status: SubscriptionStatus.SUBSCRIBED,
      id: { notIn: Array.from(whitelistIds) }
    }
  }).then((count) => ({ count }));
}

export async function pauseUnlistedTwitterSubscriptions() {
  const whitelistIds = await getWhitelistedTwitterSubscriptionIds();
  const result = await prisma.subscription.updateMany({
    where: {
      status: SubscriptionStatus.SUBSCRIBED,
      id: { notIn: Array.from(whitelistIds) }
    },
    data: {
      status: SubscriptionStatus.UNSUBSCRIBED,
      unsubscribedAt: new Date()
    }
  });
  return { updated: result.count };
}

async function getWhitelistedTwitterSubscriptionIds(listId?: string) {
  const sources = await prisma.source.findMany({
    where: {
      platform: SourcePlatform.TWITTER,
      enabled: true,
      ...(listId ? { listId } : {})
    },
    select: { subscriptionId: true, identifier: true }
  });
  const ids = new Set(sources.map((source) => source.subscriptionId).filter((id): id is string => Boolean(id)));
  const identifiers = sources.map((source) => source.identifier).filter(Boolean);
  if (identifiers.length) {
    const subscriptions = await prisma.subscription.findMany({
      where: { screenName: { in: identifiers } },
      select: { id: true }
    });
    subscriptions.forEach((subscription) => ids.add(subscription.id));
  }
  return ids;
}

export async function archiveLegacyQueuedTweets() {
  const result = await prisma.tweet.updateMany({
    where: {
      routingStatus: 'LLM_QUEUED',
      insights: null,
      abandonedAt: null
    },
    data: {
      abandonedAt: new Date(),
      abandonReason: 'legacy-paused'
    }
  });
  return { updated: result.count };
}

export async function fetchSourceList(listId: string, options: { limit?: number; force?: boolean } = {}) {
  const list = await prisma.sourceList.findUnique({
    where: { id: listId },
    include: {
      sources: {
        where: { enabled: true },
        include: { subscription: true },
        orderBy: [{ lastFetchedAt: 'asc' }, { createdAt: 'asc' }]
      }
    }
  });
  if (!list) {
    throw new Error('SourceList not found');
  }
  if (!list.enabled && !options.force) {
    return { listId, skipped: true, reason: 'source-list-disabled', results: [] as SourceListFetchResult[] };
  }

  const cooldownHours = Math.max(0, list.sourceCooldownHours || config.SOURCE_LIST_SOURCE_COOLDOWN_HOURS);
  const limit = options.limit ?? list.batchSize ?? config.SOURCE_LIST_FETCH_BATCH_SIZE;
  const dueOptions: Parameters<typeof selectDueSources>[1] = {
    cooldownHours,
    limit
  };
  if (typeof options.force === 'boolean') {
    dueOptions.force = options.force;
  }
  const selected = selectDueSources(list.sources, dueOptions);
  const results: SourceListFetchResult[] = [];

  for (const source of selected) {
    if (source.platform !== SourcePlatform.TWITTER) {
      await prisma.source.update({
        where: { id: source.id },
        data: { lastFetchedAt: new Date() }
      });
      results.push({
        sourceId: source.id,
        platform: source.platform,
        identifier: source.identifier,
        processed: 0,
        inserted: 0,
        skipped: true,
        reason: 'unsupported-platform'
      });
      continue;
    }

    try {
      const subscription =
        source.subscription ??
        (await createSubscriptionIfNotExists({
          screenName: source.identifier,
          ...(source.displayName ? { displayName: source.displayName } : {}),
          tags: source.tags
        })).subscription;
      const result = await fetchTweets(subscription);
      await prisma.source.update({
        where: { id: source.id },
        data: {
          subscriptionId: subscription.id,
          lastFetchedAt: new Date(),
          lastError: null,
          lastErrorAt: null
        }
      });
      results.push({
        sourceId: source.id,
        platform: source.platform,
        identifier: source.identifier,
        processed: result.processed,
        inserted: result.inserted
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      logger.error('SourceList source fetch failed', {
        listId,
        sourceId: source.id,
        platform: source.platform,
        identifier: source.identifier,
        error: message
      });
      await prisma.source.update({
        where: { id: source.id },
        data: {
          lastError: message,
          lastErrorAt: new Date()
        }
      });
      results.push({
        sourceId: source.id,
        platform: source.platform,
        identifier: source.identifier,
        processed: 0,
        inserted: 0,
        error: message
      });
    }
  }

  return {
    listId,
    skipped: false,
    cooldownHours,
    selected: selected.length,
    results
  };
}
