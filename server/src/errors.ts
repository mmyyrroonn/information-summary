export class AiLockUnavailableError extends Error {
  constructor(message = 'AI processing lock is currently held by another worker') {
    super(message);
    this.name = 'AiLockUnavailableError';
  }
}

export type TweetBatchFailureReason = 'content-risk' | 'max-retries' | 'unknown';

export interface TweetBatchFailureMeta {
  reason: TweetBatchFailureReason;
  tweetIds: string[];
  attempts: number;
  lastErrorMessage?: string;
}

export class TweetBatchFailedError extends Error {
  readonly reason: TweetBatchFailureReason;
  readonly tweetIds: string[];
  readonly attempts: number;
  readonly lastErrorMessage?: string;

  constructor(message: string, meta: TweetBatchFailureMeta) {
    super(message);
    this.name = 'TweetBatchFailedError';
    this.reason = meta.reason;
    this.tweetIds = meta.tweetIds;
    this.attempts = meta.attempts;
    if (meta.lastErrorMessage !== undefined) {
      this.lastErrorMessage = meta.lastErrorMessage;
    }
  }
}
