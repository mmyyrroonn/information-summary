import OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import { safeJsonParse } from '../../utils/json';
import { delay } from './shared';

export type ChatProvider = 'deepseek' | 'dashscope';

const clients: Record<ChatProvider, OpenAI | null> = {
  deepseek: config.DEEPSEEK_API_KEY
    ? new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: config.DEEPSEEK_API_KEY })
    : null,
  dashscope: config.DASHSCOPE_API_KEY
    ? new OpenAI({ apiKey: config.DASHSCOPE_API_KEY, baseURL: config.DASHSCOPE_BASE_URL })
    : null
};

const CHAT_COMPLETION_MAX_RETRIES = 3;
const CHAT_COMPLETION_RETRY_DELAY_MS = 2000;
const CHAT_COMPLETION_PREVIEW_LIMIT = 2000;
const CHAT_COMPLETION_TIMEOUT_MS = 5 * 60_000;
const CHAT_COMPLETION_SDK_MAX_RETRIES = 0;

type ChatCompletionRequest = Parameters<OpenAI['chat']['completions']['create']>[0];
type ChatCompletionResponse = Awaited<ReturnType<OpenAI['chat']['completions']['create']>>;

function ensureClient(provider: ChatProvider) {
  const client = clients[provider];
  if (!client) {
    if (provider === 'dashscope') {
      throw new Error('DASHSCOPE_API_KEY missing, cannot call AI');
    }
    throw new Error('DEEPSEEK_API_KEY missing, cannot call AI');
  }
  return client;
}

function isResponseFormatError(error: unknown) {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('response_format');
}

function extractCompletionContent(response: ChatCompletionResponse) {
  if ('choices' in response) {
    return response.choices?.[0]?.message?.content ?? '';
  }
  return '';
}

function extractErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('status' in error && typeof (error as Record<string, unknown>).status === 'number') {
    return (error as Record<string, number>).status;
  }
  return undefined;
}

export async function runChatCompletion(
  request: ChatCompletionRequest,
  context?: Record<string, unknown>,
  options?: { provider?: ChatProvider }
): Promise<string> {
  const provider = options?.provider ?? 'deepseek';
  const openai = ensureClient(provider);
  let attempt = 0;
  let lastError: unknown = null;
  const stage = typeof context?.stage === 'string' ? String(context.stage) : undefined;
  const logContext = { ...(context ?? {}), provider };

  while (attempt < CHAT_COMPLETION_MAX_RETRIES) {
    attempt += 1;
    let responsePreview: string | undefined;
    if (stage) {
      logger.info('Chat completion attempt started', {
        attempt,
        maxAttempts: CHAT_COMPLETION_MAX_RETRIES,
        timeoutMs: CHAT_COMPLETION_TIMEOUT_MS,
        ...logContext
      });
    }
    try {
      const completion = await openai.chat.completions.create(request, {
        timeout: CHAT_COMPLETION_TIMEOUT_MS,
        maxRetries: CHAT_COMPLETION_SDK_MAX_RETRIES
      });
      const content = extractCompletionContent(completion);
      responsePreview = content.slice(0, CHAT_COMPLETION_PREVIEW_LIMIT);
      return content.trim();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : 'unknown error';
      const status = extractErrorStatus(error);
      const retryInMs = CHAT_COMPLETION_RETRY_DELAY_MS * attempt;
      const errorPayload: Record<string, unknown> = {
        attempt,
        maxAttempts: CHAT_COMPLETION_MAX_RETRIES,
        ...logContext,
        status,
        error: message,
        errorType: error instanceof SyntaxError ? 'json-parse' : 'api'
      };
      if (responsePreview) {
        errorPayload.preview = responsePreview;
      }
      if (attempt >= CHAT_COMPLETION_MAX_RETRIES) {
        logger.error('Chat completion failed', errorPayload);
        break;
      }
      logger.warn('Chat completion attempt failed, retrying', { ...errorPayload, retryInMs });
      await delay(retryInMs);
    }
  }

  throw lastError ?? new Error('Chat completion failed');
}

export async function runStructuredCompletion<T>(
  request: ChatCompletionRequest,
  context?: Record<string, unknown>,
  options?: { provider?: ChatProvider }
): Promise<T> {
  const provider = options?.provider ?? 'deepseek';
  const openai = ensureClient(provider);
  let attempt = 0;
  let lastError: unknown = null;
  let forceJsonFormat = !request.response_format;
  const stage = typeof context?.stage === 'string' ? String(context.stage) : undefined;
  const logContext = { ...(context ?? {}), provider };

  while (attempt < CHAT_COMPLETION_MAX_RETRIES) {
    attempt += 1;
    let responsePreview: string | undefined;
    let payload: ChatCompletionRequest = { ...request };
    if (forceJsonFormat) {
      payload = { ...payload, response_format: { type: 'json_object' } };
    }
    if (stage === 'mid-triage') {
      logger.info('Structured completion attempt started', {
        attempt,
        maxAttempts: CHAT_COMPLETION_MAX_RETRIES,
        timeoutMs: CHAT_COMPLETION_TIMEOUT_MS,
        ...logContext
      });
    }
    try {
      const completion = await openai.chat.completions.create(payload, {
        timeout: CHAT_COMPLETION_TIMEOUT_MS,
        maxRetries: CHAT_COMPLETION_SDK_MAX_RETRIES
      });
      const content = extractCompletionContent(completion);
      responsePreview = content.slice(0, CHAT_COMPLETION_PREVIEW_LIMIT);
      return safeJsonParse<T>(content);
    } catch (error) {
      if (forceJsonFormat && isResponseFormatError(error)) {
        forceJsonFormat = false;
        attempt -= 1;
        logger.warn('Structured completion response_format unsupported, retrying without forced JSON', {
          ...logContext,
          error: error instanceof Error ? error.message : 'unknown error'
        });
        continue;
      }
      lastError = error;
      const message = error instanceof Error ? error.message : 'unknown error';
      const status = extractErrorStatus(error);
      const retryInMs = CHAT_COMPLETION_RETRY_DELAY_MS * attempt;
      const errorPayload: Record<string, unknown> = {
        attempt,
        maxAttempts: CHAT_COMPLETION_MAX_RETRIES,
        ...logContext,
        status,
        error: message,
        errorType: error instanceof SyntaxError ? 'json-parse' : 'api'
      };
      if (responsePreview) {
        errorPayload.preview = responsePreview;
      }
      if (attempt >= CHAT_COMPLETION_MAX_RETRIES) {
        logger.error('Structured completion failed', errorPayload);
        break;
      }
      logger.warn('Structured completion attempt failed, retrying', { ...errorPayload, retryInMs });
      await delay(retryInMs);
    }
  }

  throw lastError ?? new Error('Structured completion failed');
}
