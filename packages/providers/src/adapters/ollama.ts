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
    //
    // D-100: and what each model can do. Ollama's `format` holds any model to a JSON schema, so
    // every model takes a schema (the executor still checks the output against it); tool calls and
    // images are per model, read from `/api/show`'s `capabilities`. Without this every local model
    // looked like it could do neither, and D353 blocked a schema or tools on all of them.
    listModels: async () => {
      const models = await adapter.listModels();
      const [sizes, capabilities] = await Promise.all([
        ollamaModelSizes(baseUrl, options.fetchImpl),
        ollamaCapabilities(
          baseUrl,
          models.map((model) => model.modelId),
          options.fetchImpl,
        ),
      ]);
      return models.map((model) => {
        const size = sizes.get(model.modelId);
        const can = capabilities.get(model.modelId);
        const inputTypes =
          can?.has('vision') === true && !model.inputTypes.includes('image')
            ? [...model.inputTypes, 'image' as const]
            : model.inputTypes;
        return {
          ...model,
          inputTypes,
          supportsJson: true,
          supportsTools: can === undefined ? model.supportsTools : can.has('tools'),
          ...(size === undefined ? {} : { sizeBytes: size }),
        };
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

/** How many `/api/show` calls are in flight at once while a model list is read. */
const SHOW_CONCURRENCY = 4;

/**
 * Each model's `capabilities` from Ollama's `/api/show` (D-100): `completion`, `tools`, `vision`,
 * `embedding`, … Best effort and never throws: a model whose answer is missing or malformed is
 * left out, and its catalogue defaults stand.
 */
export async function ollamaCapabilities(
  baseUrl: string,
  modelIds: readonly string[],
  fetchImpl?: FetchLike,
): Promise<Map<string, Set<string>>> {
  const found = new Map<string, Set<string>>();
  const queue = [...modelIds];
  const worker = async (): Promise<void> => {
    for (let modelId = queue.shift(); modelId !== undefined; modelId = queue.shift()) {
      try {
        const body = (await postJson({
          url: `${normaliseBaseUrl(baseUrl)}/api/show`,
          body: { model: modelId },
          timeoutMs: DETECT_TIMEOUT_MS * 3,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        })) as { capabilities?: unknown } | null;
        const list = body?.capabilities;
        if (Array.isArray(list)) {
          found.set(
            modelId,
            new Set(list.filter((entry): entry is string => typeof entry === 'string')),
          );
        }
      } catch {
        // an older Ollama, or one model it cannot describe: keep the defaults
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, queue.length) }, worker));
  return found;
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
