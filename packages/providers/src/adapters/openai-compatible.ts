import { createOpenAI } from '@ai-sdk/openai';
import type { ProviderType } from '@ace/contracts';

import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import {
  createAiSdkAdapter,
  discoveredModel,
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

/** `{ data: [{ id }] }` — the listing shape every OpenAI-compatible server returns. */
export function parseOpenAiModelList(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry): ModelInfo[] => {
    const id = (entry as { id?: unknown }).id;
    return typeof id === 'string' ? [discoveredModel(id)] : [];
  });
}

/** Trailing slashes are common in a pasted base URL and break path joining. */
export function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): ProviderAdapter {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const headers: Record<string, string> =
    options.apiKey === undefined || options.apiKey === ''
      ? {}
      : { Authorization: `Bearer ${options.apiKey}` };

  const listUrl = `${baseUrl}/v1/models`;
  const probe = async (): Promise<unknown> =>
    getJson({
      url: listUrl,
      headers,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const provider = createOpenAI({
    baseURL: `${baseUrl}/v1`,
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
  });
}
