import { createAnthropic } from '@ai-sdk/anthropic';

import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import { createAiSdkAdapter, discoveredModel, getJson, statusFromProbe, type FetchLike } from './ai-sdk.js';

/** Anthropic (FR-PRV-001). The key travels in `x-api-key`, never in a URL or a log (BR-07). */

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** Pinned: the API version header Anthropic requires on every request. */
export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function parseAnthropicModelList(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry): ModelInfo[] => {
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string') return [];
    const displayName = (entry as { display_name?: unknown }).display_name;
    return [discoveredModel(id, typeof displayName === 'string' ? displayName : undefined)];
  });
}

export function createAnthropicAdapter(options: AnthropicOptions): ProviderAdapter {
  const baseUrl = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const headers = { 'x-api-key': options.apiKey, 'anthropic-version': ANTHROPIC_VERSION };

  const probe = async (): Promise<unknown> =>
    getJson({
      url: `${baseUrl}/v1/models`,
      headers,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const provider = createAnthropic({
    apiKey: options.apiKey,
    baseURL: `${baseUrl}/v1`,
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl as typeof fetch }),
  });

  return createAiSdkAdapter({
    type: 'anthropic',
    model: (modelId) => provider(modelId),
    check: () => statusFromProbe(probe),
    listModels: async () => parseAnthropicModelList(await probe()),
  });
}
