import OpenAI from 'openai';
import { createHash } from 'crypto';
import { config } from '../config';

const client = config.DASHSCOPE_API_KEY
  ? new OpenAI({ apiKey: config.DASHSCOPE_API_KEY, baseURL: config.DASHSCOPE_BASE_URL })
  : null;

export function embeddingsEnabled() {
  return Boolean(client);
}

export function hashEmbeddingText(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function ensureClient() {
  if (!client) {
    throw new Error('DASHSCOPE_API_KEY missing, cannot call embeddings');
  }
  return client;
}

export async function createEmbeddings(texts: string[]) {
  if (!texts.length) return [];
  const openai = ensureClient();
  const response = await openai.embeddings.create({
    model: config.EMBEDDING_MODEL,
    input: texts,
    dimensions: config.EMBEDDING_DIMENSIONS
  });
  return response.data.map((entry) => entry.embedding);
}

