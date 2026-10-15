import type { ProviderAdapter } from '../adapter.js';
import {
  badEmbedResponse,
  checkVectors,
  type EmbedOptions,
  getJson,
  postJson,
  requireEmbedModel,
  type FetchLike,
} from './ai-sdk.js';
import { createOpenAiCompatibleAdapter, normaliseBaseUrl } from './openai-compatible.js';

/**
 * Ollama (FR-PRV-007). It speaks the OpenAI API, so this is `openai_compatible` with the local
 * address filled in and a probe the engine can run before the user has added anything.
 */

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export interface OllamaOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function createOllamaAdapter(options: OllamaOptions = {}): ProviderAdapter {
  const baseUrl = normaliseBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
  const adapter = createOpenAiCompatibleAdapter({
    type: 'ollama',
    baseUrl,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  return {
    ...adapter,
    // PG-1.4 (D359): the native `/api/tags` list carries each model's size on disk. Best effort —
    // a service that does not answer it still lists its models.
    listModels: async () => {
      const models = await adapter.listModels();
      const sizes = await ollamaModelSizes(baseUrl, options.fetchImpl);
      return models.map((model) => {
        const size = sizes.get(model.modelId);
        return size === undefined ? model : { ...model, sizeBytes: size };
      });
    },
    // Ollama's native batch endpoint, not the OpenAI-style one this adapter otherwise speaks.
    embed: async (texts: string[], embedOptions?: EmbedOptions) => {
      const model = requireEmbedModel(embedOptions);
      if (texts.length === 0) return [];
      const body = (await postJson({
        url: `${baseUrl}/api/embed`,
        body: { model, input: texts },
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })) as { embeddings?: unknown };
      if (!Array.isArray(body.embeddings)) throw badEmbedResponse('no "embeddings" list');
      return checkVectors(body.embeddings, texts.length);
    },
  };
}

/**
 * Each model's size on disk from Ollama's `/api/tags` (PG-1.4), keyed by both its `name` and
 * `model` field. Never throws: an empty map when the list is missing or malformed.
 */
export async function ollamaModelSizes(
  baseUrl: string,
  fetchImpl?: FetchLike,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let body: unknown;
  try {
    body = await getJson({
      url: `${normaliseBaseUrl(baseUrl)}/api/tags`,
      timeoutMs: DETECT_TIMEOUT_MS * 3,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
  } catch {
    return sizes;
  }
  const list = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return sizes;
  for (const entry of list as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, model, size } = entry as { name?: unknown; model?: unknown; size?: unknown };
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) continue;
    for (const key of [name, model]) if (typeof key === 'string') sizes.set(key, size);
  }
  return sizes;
}

/** How long detection waits. Short: this runs on first load and must never hold the UI up. */
export const DETECT_TIMEOUT_MS = 1_000;

export interface OllamaDetection {
  baseUrl: string;
  detected: boolean;
}

/**
 * `GET /providers/detect` (FR-PRV-007, TC-PRV-008). Never throws — "nothing answered" is the
 * expected outcome on a machine without Ollama, not an error worth reporting.
 */
export async function detectOllama(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
  fetchImpl?: FetchLike,
): Promise<OllamaDetection> {
  const url = normaliseBaseUrl(baseUrl);
  try {
    await getJson({
      url: `${url}/v1/models`,
      timeoutMs: DETECT_TIMEOUT_MS,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    return { baseUrl: url, detected: true };
  } catch {
    return { baseUrl: url, detected: false };
  }
}
