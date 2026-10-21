import { createOpenAI } from '@ai-sdk/openai';
import type { ProviderType } from '@ace/contracts';

import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import {
  byChatName,
  createAiSdkAdapter,
  discoveredModel,
  embedOpenAiStyle,
  getJson,
  statusFromProbe,
  type FetchLike,
} from './ai-sdk.js';

/**
 * Any server that speaks the OpenAI HTTP API (FR-PRV-006): LM Studio, vLLM, llama.cpp, a company
 * gateway — and Ollama, which is this adapter with a default base URL (`ollama.ts`).
 *
 * The key is optional, because a local server usually has none.
 */

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  /** Overridden by `ollama.ts`, so a provider row reports the type the user chose. */
  type?: ProviderType;
}

/**
 * `{ data: [{ id }] }` — the listing shape every OpenAI-compatible server returns. It says nothing
 * about what a model does, so an embedder, a speech or an image model is told apart by its name
 * and kept unavailable for nodes [audit P-6].
 */
export function parseOpenAiModelList(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry): ModelInfo[] => {
    const id = (entry as { id?: unknown }).id;
    return typeof id === 'string' ? [byChatName(discoveredModel(id))] : [];
  });
}

/** Trailing slashes are common in a pasted base URL and break path joining. */
export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** A path that already names the API version: `/v1`, `/v2`, `/api/v1`, `/openai/v1`, `/v1beta/openai`. */
const VERSIONED_PATH = /\/v\d+(?:alpha|beta)?\d*(?:\/openai)?$/i;

/**
 * The API root a base URL stands for [audit P-4]. A URL that already ends in a version — what most
 * servers print as "the base URL" — is the root as it is, so `…/v1` no longer becomes `…/v1/v1`.
 * Any other gets `/v1`, which is how every base URL was read before: a stored
 * `http://127.0.0.1:1234` keeps working.
 */
export function openAiApiRoot(baseUrl: string): string {
  const url = normaliseBaseUrl(baseUrl);
  return VERSIONED_PATH.test(url) ? url : `${url}/v1`;
}

export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): ProviderAdapter {
  const apiRoot = openAiApiRoot(options.baseUrl);
  const headers: Record<string, string> =
    options.apiKey === undefined || options.apiKey === ''
      ? {}
      : { Authorization: `Bearer ${options.apiKey}` };

  const listUrl = `${apiRoot}/models`;
  const probe = async (): Promise<unknown> =>
    getJson({
      url: listUrl,
      headers,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const provider = createOpenAI({
    baseURL: apiRoot,
    // The SDK insists on a key; a local server ignores whatever is sent.
    apiKey: options.apiKey ?? 'not-required',
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl as typeof fetch }),
  });

  return createAiSdkAdapter({
    type: options.type ?? 'openai_compatible',
    // `.chat` rather than the default: a compatible server implements chat completions, not
    // OpenAI's newer Responses API.
    model: (modelId) => provider.chat(modelId),
    check: () => statusFromProbe(probe),
    listModels: async () => parseOpenAiModelList(await probe()),
    embed: (texts, embedOptions) =>
      embedOpenAiStyle(apiRoot, headers, options.fetchImpl, texts, embedOptions),
  });
}
