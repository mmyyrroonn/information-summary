import type { Prisma, SourcePlatform } from '@prisma/client';

export type TweetScopeSource = {
  platform: SourcePlatform | string;
  identifier: string;
  subscriptionId?: string | null;
};

function normalizeTwitterIdentifier(identifier: string) {
  return identifier.replace(/^@/, '').trim().toLowerCase();
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

export function buildSourceTweetScopeFilter(sources: TweetScopeSource[]): Prisma.TweetWhereInput {
  const twitterSources = sources.filter((source) => source.platform === 'TWITTER');
  const subscriptionIds = unique(
    twitterSources.map((source) => source.subscriptionId).filter((id): id is string => Boolean(id))
  );
  const identifiers = unique(
    twitterSources.map((source) => normalizeTwitterIdentifier(source.identifier)).filter(Boolean)
  );

  const filters: Prisma.TweetWhereInput[] = [];
  if (subscriptionIds.length) {
    filters.push({ subscriptionId: { in: subscriptionIds } });
  }
  if (identifiers.length) {
    filters.push({ subscription: { screenName: { in: identifiers } } });
  }

  return filters.length ? { OR: filters } : { id: { in: [] } };
}
