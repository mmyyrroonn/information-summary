import axios from 'axios';
import { config } from '../config';
import {
  RapidApiFollowingResponse,
  RapidApiListMembersResponse,
  RapidApiPaginatedUsersResponse,
  RapidApiTimelineResponse,
  RapidApiUser
} from '../types/twitter';

const twitterClient = axios.create({
  baseURL: `https://${config.RAPIDAPI_HOST}`,
  headers: {
    'x-rapidapi-host': config.RAPIDAPI_HOST,
    'x-rapidapi-key': config.RAPIDAPI_KEY ?? ''
  }
});

function assertRapidApiKey() {
  if (!config.RAPIDAPI_KEY) {
    throw new Error('Missing RAPIDAPI_KEY env, cannot fetch timeline');
  }
}

function buildUsersPage<T extends RapidApiPaginatedUsersResponse>(data: T, users: RapidApiUser[]): RapidApiUsersPage {
  return {
    users,
    nextCursor: data.next_cursor ?? null,
    hasMore: Boolean(data.more_users)
  };
}

export async function fetchTimeline(screenName: string): Promise<RapidApiTimelineResponse> {
  assertRapidApiKey();

  const response = await twitterClient.get<RapidApiTimelineResponse>(`/timeline.php`, {
    params: { screenname: screenName }
  });

  return response.data;
}

export interface RapidApiUsersPage {
  users: RapidApiUser[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function fetchListMembersPage(listId: string, cursor?: string): Promise<RapidApiUsersPage> {
  assertRapidApiKey();
  if (!listId.trim()) {
    throw new Error('listId is required');
  }

  const response = await twitterClient.get<RapidApiListMembersResponse>(`/list_members.php`, {
    params: {
      list_id: listId,
      ...(cursor ? { cursor } : {})
    }
  });

  return buildUsersPage(response.data, response.data.members ?? []);
}

export async function fetchFollowingPage(options: {
  screenName?: string;
  userId?: string;
  cursor?: string;
}): Promise<RapidApiUsersPage> {
  assertRapidApiKey();
  const params: Record<string, string> = {};
  if (options.cursor) {
    params.cursor = options.cursor;
  }
  if (options.screenName) {
    params.screenname = options.screenName;
  }
  if (options.userId) {
    params.user_id = options.userId;
  }
  if (!params.screenname && !params.user_id) {
    throw new Error('screenName or userId is required');
  }

  const response = await twitterClient.get<RapidApiFollowingResponse>(`/following.php`, { params });
  return buildUsersPage(response.data, response.data.following ?? []);
}
