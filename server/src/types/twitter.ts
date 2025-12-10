export interface RapidApiTweet {
  tweet_id: string;
  created_at: string;
  text: string;
  lang?: string;
  favorites?: number;
  replies?: number;
  retweets?: number;
  quotes?: number;
  views?: string;
  entities?: Record<string, unknown>;
  media?: unknown;
  author: {
    rest_id: string;
    name: string;
    screen_name: string;
    avatar?: string;
  };
  quoted?: RapidApiTweet;
  conversation_id?: string;
  source?: string;
}

export interface RapidApiTimelineResponse {
  pinned?: RapidApiTweet;
  timeline: RapidApiTweet[];
  next_cursor?: string;
  prev_cursor?: string;
}

export interface RapidApiUser {
  user_id: string;
  screen_name: string;
  name?: string;
  description?: string;
  location?: string;
  profile_image?: string | null;
  statuses_count?: number;
  followers_count?: number;
  friends_count?: number;
  media_count?: number;
  created_at?: string;
  website?: string;
  verified?: boolean;
  blue_verified?: boolean;
  business_account?: unknown;
  affiliates?: unknown;
}

export interface RapidApiPaginatedUsersResponse {
  next_cursor?: string;
  more_users?: boolean;
  status?: string;
}

export interface RapidApiListMembersResponse extends RapidApiPaginatedUsersResponse {
  members: RapidApiUser[];
}

export interface RapidApiFollowingResponse extends RapidApiPaginatedUsersResponse {
  following: RapidApiUser[];
}
