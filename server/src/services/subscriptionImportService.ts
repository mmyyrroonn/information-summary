import { logger } from '../logger';
import { createSubscriptionIfNotExists } from './subscriptionService';
import { fetchFollowingPage, fetchListMembersPage, RapidApiUsersPage } from './twitterService';

export interface SubscriptionImportResult {
  fetched: number;
  created: number;
  existing: number;
  skipped: number;
  nextCursor: string | null;
  hasMore: boolean;
  users: Array<{
    subscriptionId: string;
    screenName: string;
    displayName: string | null;
    created: boolean;
  }>;
}

type ImportSource = 'list' | 'following';

async function processUsersPage(
  source: ImportSource,
  identifier: string,
  fetcher: () => Promise<RapidApiUsersPage>
): Promise<SubscriptionImportResult> {
  logger.info(`Fetching ${source} users`, { source, identifier });
  const page = await fetcher();
  logger.info(`Fetched ${page.users.length} ${source} users`, {
    source,
    identifier,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore
  });

  const users: SubscriptionImportResult['users'] = [];
  let created = 0;
  let existing = 0;
  let skipped = 0;

  for (const user of page.users) {
    if (!user.screen_name) {
      skipped += 1;
      logger.warn('Skipping user without screen name', { source, identifier, userId: user.user_id });
      continue;
    }

    const payload: {
      screenName: string;
      displayName?: string;
      avatarUrl?: string | null;
    } = {
      screenName: user.screen_name
    };
    if (user.name) {
      payload.displayName = user.name;
    }
    if (typeof user.profile_image !== 'undefined') {
      payload.avatarUrl = user.profile_image;
    }
    const result = await createSubscriptionIfNotExists(payload);

    users.push({
      subscriptionId: result.subscription.id,
      screenName: result.subscription.screenName,
      displayName: result.subscription.displayName ?? null,
      created: result.created
    });

    if (result.created) {
      created += 1;
      logger.info('Subscribed new user', {
        source,
        identifier,
        screenName: result.subscription.screenName
      });
    } else {
      existing += 1;
      logger.info('User already subscribed', {
        source,
        identifier,
        screenName: result.subscription.screenName
      });
    }
  }

  const summary: SubscriptionImportResult = {
    fetched: page.users.length,
    created,
    existing,
    skipped,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    users
  };

  logger.info('Completed subscription import page', {
    source,
    identifier,
    created,
    existing,
    skipped,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore
  });

  return summary;
}

export async function importListMembers(options: { listId: string; cursor?: string }) {
  if (!options.listId?.trim()) {
    throw new Error('listId is required');
  }
  return processUsersPage('list', options.listId, () => fetchListMembersPage(options.listId, options.cursor));
}

export async function importFollowingUsers(options: { screenName?: string; userId?: string; cursor?: string }) {
  if (!options.screenName && !options.userId) {
    throw new Error('screenName or userId is required');
  }
  const identifier = options.screenName ?? options.userId ?? 'unknown';
  return processUsersPage('following', identifier, () => fetchFollowingPage(options));
}
