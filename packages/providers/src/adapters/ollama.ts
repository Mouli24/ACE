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
        const shown = capabilities.get(model.modelId);
        const can = shown?.capabilities;
        const inputTypes =
          can?.has('vision') === true && !model.inputTypes.includes('image')
            ? [...model.inputTypes, 'image' as const]
            : model.inputTypes;
        return {
          ...model,
          inputTypes,
          supportsJson: true,
          supportsTools: can === undefined ? model.supportsTools : can.has('tools'),
          // The model's real window, not the catalogue's 8192 guess (agentic nodes P2, Task 4).
          ...(shown?.contextLength === undefined ? {} : { contextWindow: shown.contextLength }),
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

/** The `<arch>.context_length` entry of `/api/show`'s `model_info`, when it is a sane integer. */
function contextLengthOf(info: unknown): number | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith('.context_length') && typeof value === 'number' && Number.isInteger(value)) {
      return value >= 1 ? value : undefined;
    }
  }
  return undefined;
}

/** How many `/api/show` calls are in flight at once while a model list is read. */
const SHOW_CONCURRENCY = 4;

/** What `/api/show` says about one model. */
export interface OllamaShown {
  capabilities: Set<string>;
  /** `model_info["<arch>.context_length"]`, when Ollama reports a usable number. */
  contextLength?: number;
}

/**
 * Each model's `capabilities` from Ollama's `/api/show` (D-100): `completion`, `tools`, `vision`,
 * `embedding`, … and its context length (agentic nodes P2, Task 4). Best effort and never throws: a model whose answer is missing or malformed is
 * left out, and its catalogue defaults stand.
 */
export async function ollamaCapabilities(
  baseUrl: string,
  modelIds: readonly string[],
  fetchImpl?: FetchLike,
): Promise<Map<string, OllamaShown>> {
  const found = new Map<string, OllamaShown>();
  const queue = [...modelIds];
  const worker = async (): Promise<void> => {
    for (let modelId = queue.shift(); modelId !== undefined; modelId = queue.shift()) {
      try {
        const body = (await postJson({
          url: `${normaliseBaseUrl(baseUrl)}/api/show`,
          body: { model: modelId },
          timeoutMs: DETECT_TIMEOUT_MS * 3,
          ...(fetchImpl === undefined ? {} : { fetchImpl }),
        })) as { capabilities?: unknown; model_info?: unknown } | null;
        const list = body?.capabilities;
        if (Array.isArray(list)) {
          const contextLength = contextLengthOf(body?.model_info);
          found.set(modelId, {
            capabilities: new Set(
              list.filter((entry): entry is string => typeof entry === 'string'),
            ),
            ...(contextLength === undefined ? {} : { contextLength }),
          });
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

/* -------------------------------------------------------------------------------------------- */
/* Models on this machine (PG-1.4, D359)                                                         */
/* -------------------------------------------------------------------------------------------- */

/** How long loading a model into memory may take — a 7B model from a cold disk takes a while. */
export const OLLAMA_LOAD_TIMEOUT_MS = 5 * 60_000;
/** How long an unload or a `/api/ps` may take. */
export const OLLAMA_SHORT_TIMEOUT_MS = 30_000;
/** A pull is abandoned when Ollama sends nothing for this long; a pull itself may take hours. */
export const OLLAMA_PULL_IDLE_TIMEOUT_MS = 5 * 60_000;
/** How long Ollama keeps a model loaded by Load. */
export const OLLAMA_KEEP_ALIVE = '10m';

export interface OllamaRunningModel {
  modelId: string;
  sizeBytes?: number;
  sizeVramBytes?: number;
  expiresAt?: string;
}

const nonNegativeInt = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

/** What `/api/version` answers, or `undefined` when nothing answers. Never throws. */
export async function ollamaVersion(
  baseUrl: string,
  fetchImpl?: FetchLike,
  timeoutMs: number = DETECT_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const body = (await getJson({
      url: `${normaliseBaseUrl(baseUrl)}/api/version`,
      timeoutMs,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    })) as { version?: unknown } | null;
    return typeof body?.version === 'string' ? body.version : '';
  } catch {
    return undefined;
  }
}

/** The models Ollama holds in memory now (`GET /api/ps`). */
export async function ollamaRunningModels(
  baseUrl: string,
  fetchImpl?: FetchLike,
): Promise<OllamaRunningModel[]> {
  const body = (await getJson({
    url: `${normaliseBaseUrl(baseUrl)}/api/ps`,
    timeoutMs: OLLAMA_SHORT_TIMEOUT_MS,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })) as { models?: unknown } | null;
  const list = Array.isArray(body?.models) ? (body.models as unknown[]) : [];
  const found: OllamaRunningModel[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const name = typeof row['name'] === 'string' ? row['name'] : row['model'];
    if (typeof name !== 'string' || name === '') continue;
    const size = nonNegativeInt(row['size']);
    const vram = nonNegativeInt(row['size_vram']);
    const expires = row['expires_at'];
    found.push({
      modelId: name,
      ...(size === undefined ? {} : { sizeBytes: size }),
      ...(vram === undefined ? {} : { sizeVramBytes: vram }),
      ...(typeof expires === 'string' ? { expiresAt: expires } : {}),
    });
  }
  return found;
}

/** Load a model into memory and keep it there for {@link OLLAMA_KEEP_ALIVE}. */
export async function ollamaLoadModel(
  baseUrl: string,
  modelId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  await postJson({
    url: `${normaliseBaseUrl(baseUrl)}/api/generate`,
    body: { model: modelId, prompt: '', keep_alive: OLLAMA_KEEP_ALIVE, stream: false },
    timeoutMs: OLLAMA_LOAD_TIMEOUT_MS,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

/** Unload a model from memory now. */
export async function ollamaUnloadModel(
  baseUrl: string,
  modelId: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  await postJson({
    url: `${normaliseBaseUrl(baseUrl)}/api/generate`,
    body: { model: modelId, prompt: '', keep_alive: 0, stream: false },
    timeoutMs: OLLAMA_SHORT_TIMEOUT_MS,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

export interface OllamaPullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/**
 * Pull a model (`POST /api/pull`, streamed NDJSON), reporting each progress line. Resolves when
 * Ollama says `success`; rejects with its reason otherwise. Abandoned when nothing arrives for
 * {@link OLLAMA_PULL_IDLE_TIMEOUT_MS}, never on total time — a large model takes as long as it takes.
 */
export async function ollamaPullModel(
  baseUrl: string,
  name: string,
  onProgress: (progress: OllamaPullProgress) => void,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal; idleTimeoutMs?: number } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const idleMs = options.idleTimeoutMs ?? OLLAMA_PULL_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), idleMs);
  };

  try {
    touch();
    const response = await fetchImpl(`${normaliseBaseUrl(baseUrl)}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(pullErrorText(text) ?? `Ollama answered ${response.status}.`);
    }
    if (response.body === null) throw new Error('Ollama sent no progress.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let succeeded = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line !== '' && handlePullLine(line, onProgress)) succeeded = true;
      }
    }
    const rest = buffer.trim();
    if (rest !== '' && handlePullLine(rest, onProgress)) succeeded = true;
    if (!succeeded) throw new Error('The pull ended before Ollama said it succeeded.');
  } catch (error) {
    if (controller.signal.aborted && options.signal?.aborted !== true) {
      throw new Error(
        `Ollama sent nothing for ${Math.round(idleMs / 1000)} s; the pull was stopped.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (idle !== undefined) clearTimeout(idle);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** One NDJSON line of a pull. True when it is the `success` line; throws on an `error` line. */
function handlePullLine(line: string, onProgress: (progress: OllamaPullProgress) => void): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const row = parsed as Record<string, unknown>;
  if (typeof row['error'] === 'string') throw new Error(row['error']);
  const status = typeof row['status'] === 'string' ? row['status'] : '';
  const completed = nonNegativeInt(row['completed']);
  const total = nonNegativeInt(row['total']);
  onProgress({
    status,
    ...(completed === undefined ? {} : { completed }),
    ...(total === undefined ? {} : { total }),
  });
  return status === 'success';
}

function pullErrorText(text: string): string | undefined {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : undefined;
  } catch {
    return text.trim() === '' ? undefined : text.trim().slice(0, 300);
  }
}
