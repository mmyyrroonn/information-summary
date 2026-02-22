import OpenAI from 'openai';
import { config } from '../../config';
import { logger } from '../../logger';
import { safeJsonParse } from '../../utils/json';
import { delay } from './shared';

export type MiniMaxApiMode = 'openai-completions' | 'anthropic-messages';

export interface MiniMaxConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

interface MiniMaxRuntimeConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiMode: MiniMaxApiMode;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  temperature?: number;
  system?: string;
  messages: AnthropicMessage[];
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
}

const DEFAULT_MINIMAX_BASE_URL = 'https://api.minimax.chat/v1';
const DEFAULT_MINIMAX_MODEL = 'MiniMax-M2.5';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MAX_TOKENS = 2048;
const CHAT_COMPLETION_MAX_RETRIES = 3;
const CHAT_COMPLETION_RETRY_DELAY_MS = 2000;
const CHAT_COMPLETION_PREVIEW_LIMIT = 2000;
const CHAT_COMPLETION_TIMEOUT_MS = 5 * 60_000;
const CHAT_COMPLETION_SDK_MAX_RETRIES = 0;

type ChatCompletionRequest = Parameters<OpenAI['chat']['completions']['create']>[0];
type ChatCompletionResponse = Awaited<ReturnType<OpenAI['chat']['completions']['create']>>;

export function resolveMiniMaxApiMode(baseURL?: string): MiniMaxApiMode {
  const normalized = (baseURL ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (normalized.endsWith('/anthropic')) {
    return 'anthropic-messages';
  }
  return 'openai-completions';
}

function resolveMiniMaxRuntimeConfig(override?: MiniMaxConfig): MiniMaxRuntimeConfig | null {
  const apiKey = (override?.apiKey ?? config.MINIMAX_API_KEY ?? '').trim();
  if (!apiKey) {
    logger.warn('MINIMAX_API_KEY not configured');
    return null;
  }
  const baseURL = (override?.baseURL ?? config.MINIMAX_BASE_URL ?? DEFAULT_MINIMAX_BASE_URL).trim();
  const model = (override?.model ?? config.MINIMAX_MODEL ?? DEFAULT_MINIMAX_MODEL).trim() || DEFAULT_MINIMAX_MODEL;
  return {
    apiKey,
    baseURL,
    model,
    apiMode: resolveMiniMaxApiMode(baseURL)
  };
}

function getMiniMaxClient(runtime: MiniMaxRuntimeConfig): OpenAI {
  return new OpenAI({
    apiKey: runtime.apiKey,
    baseURL: runtime.baseURL
  });
}

export function createMiniMaxClient(clientConfig: MiniMaxConfig): OpenAI | null {
  const runtime = resolveMiniMaxRuntimeConfig(clientConfig);
  if (!runtime || runtime.apiMode === 'anthropic-messages') {
    return null;
  }
  return getMiniMaxClient(runtime);
}

function extractCompletionContent(response: ChatCompletionResponse): string {
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

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  content.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      const text = record.text.trim();
      if (text) parts.push(text);
    }
  });
  return parts.join('\n').trim();
}

export function buildAnthropicRequestFromChatRequest(
  request: ChatCompletionRequest,
  fallbackModel: string
): AnthropicMessagesRequest {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];
  const sourceMessages = Array.isArray(request.messages) ? request.messages : [];

  sourceMessages.forEach((message) => {
    if (!message || typeof message !== 'object' || !('role' in message)) {
      return;
    }
    const role = String((message as { role: unknown }).role);
    const text = extractTextContent((message as { content?: unknown }).content);
    if (!text) return;
    if (role === 'system' || role === 'developer') {
      systemParts.push(text);
      return;
    }
    if (role === 'user' || role === 'assistant') {
      messages.push({ role, content: text });
    }
  });

  const model = typeof request.model === 'string' && request.model.trim() ? request.model : fallbackModel;
  const maxTokens =
    typeof request.max_completion_tokens === 'number'
      ? request.max_completion_tokens
      : typeof request.max_tokens === 'number'
        ? request.max_tokens
        : DEFAULT_ANTHROPIC_MAX_TOKENS;

  const payload: AnthropicMessagesRequest = {
    model,
    max_tokens: Math.max(1, Math.floor(maxTokens)),
    messages
  };
  if (typeof request.temperature === 'number') {
    payload.temperature = request.temperature;
  }
  if (systemParts.length) {
    payload.system = systemParts.join('\n\n');
  }
  return payload;
}

function extractAnthropicText(response: AnthropicMessagesResponse): string {
  if (!Array.isArray(response.content)) {
    return '';
  }
  const texts = response.content
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text.trim() : ''))
    .filter((text) => text.length > 0);
  return texts.join('\n').trim();
}

async function runAnthropicMessagesCompletion(
  runtime: MiniMaxRuntimeConfig,
  request: ChatCompletionRequest
): Promise<string> {
  const payload = buildAnthropicRequestFromChatRequest(request, runtime.model);
  const endpoint = `${runtime.baseURL.replace(/\/+$/, '')}/v1/messages`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHAT_COMPLETION_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': runtime.apiKey,
        'anthropic-version': DEFAULT_ANTHROPIC_VERSION
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const raw = (await response.text()).slice(0, 500);
      throw new Error(`MiniMax anthropic request failed: ${response.status} ${raw}`);
    }

    const data = (await response.json()) as AnthropicMessagesResponse;
    return extractAnthropicText(data);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function runMiniMaxChatCompletion(
  request: ChatCompletionRequest,
  context?: Record<string, unknown>
): Promise<string> {
  return runMiniMaxChatCompletionWithConfig(request, {}, context);
}

export async function runMiniMaxChatCompletionWithConfig(
  request: ChatCompletionRequest,
  clientConfig: MiniMaxConfig,
  context?: Record<string, unknown>
): Promise<string> {
  const runtime = resolveMiniMaxRuntimeConfig(clientConfig);
  if (!runtime) {
    throw new Error('MiniMax client not initialized - missing MINIMAX_API_KEY');
  }

  const openai = runtime.apiMode === 'openai-completions' ? getMiniMaxClient(runtime) : null;
  let attempt = 0;
  let lastError: unknown = null;
  const stage = typeof context?.stage === 'string' ? String(context.stage) : undefined;
  const logContext = { ...(context ?? {}), provider: 'minimax', apiMode: runtime.apiMode };

  while (attempt < CHAT_COMPLETION_MAX_RETRIES) {
    attempt += 1;
    let responsePreview: string | undefined;
    if (stage) {
      logger.info('MiniMax chat completion attempt started', {
        attempt,
        maxAttempts: CHAT_COMPLETION_MAX_RETRIES,
        timeoutMs: CHAT_COMPLETION_TIMEOUT_MS,
        ...logContext
      });
    }
    try {
      const content =
        runtime.apiMode === 'openai-completions'
          ? extractCompletionContent(
              await openai!.chat.completions.create(request, {
                timeout: CHAT_COMPLETION_TIMEOUT_MS,
                maxRetries: CHAT_COMPLETION_SDK_MAX_RETRIES
              })
            )
          : await runAnthropicMessagesCompletion(runtime, request);
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
        logger.error('MiniMax chat completion failed', errorPayload);
        break;
      }
      logger.warn('MiniMax chat completion attempt failed, retrying', { ...errorPayload, retryInMs });
      await delay(retryInMs);
    }
  }

  throw lastError ?? new Error('MiniMax chat completion failed');
}

export async function runMiniMaxStructuredCompletion<T>(
  request: ChatCompletionRequest,
  context?: Record<string, unknown>
): Promise<T> {
  return runMiniMaxStructuredCompletionWithConfig<T>(request, {}, context);
}

export async function runMiniMaxStructuredCompletionWithConfig<T>(
  request: ChatCompletionRequest,
  clientConfig: MiniMaxConfig,
  context?: Record<string, unknown>
): Promise<T> {
  const payload: ChatCompletionRequest = request.response_format
    ? { ...request }
    : { ...request, response_format: { type: 'json_object' } };
  const content = await runMiniMaxChatCompletionWithConfig(payload, clientConfig, context);
  return safeJsonParse<T>(content);
}
