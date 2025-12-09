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
