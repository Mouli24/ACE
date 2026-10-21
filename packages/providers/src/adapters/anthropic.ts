import { createAnthropic } from '@ai-sdk/anthropic';

import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import {
  createAiSdkAdapter,
  discoveredModel,
  getJson,
  MAX_LIST_PAGES,
  statusFromProbe,
  withFamilyDefaults,
  type FetchLike,
} from './ai-sdk.js';

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
    // [audit P-2] A Claude model takes tools, a schema and images; the listing does not say so.
    return [
      withFamilyDefaults(
        discoveredModel(id, typeof displayName === 'string' ? displayName : undefined),
      ),
    ];
  });
}

export function createAnthropicAdapter(options: AnthropicOptions): ProviderAdapter {
  const baseUrl = (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
  const headers = { 'x-api-key': options.apiKey, 'anthropic-version': ANTHROPIC_VERSION };

  // [audit P-14] The listing is paged (20 by default): ask for the most a page holds, and follow
  // `has_more` from `last_id`.
  const page = async (afterId?: string): Promise<unknown> => {
    const after = afterId === undefined ? '' : `&after_id=${encodeURIComponent(afterId)}`;
    return getJson({
      url: `${baseUrl}/v1/models?limit=1000${after}`,
      headers,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  };
  const probe = (): Promise<unknown> => page();
  const listAll = async (): Promise<ModelInfo[]> => {
    const models: ModelInfo[] = [];
    let afterId: string | undefined;
    for (let pages = 0; pages < MAX_LIST_PAGES; pages += 1) {
      const body = await page(afterId);
      models.push(...parseAnthropicModelList(body));
      const { has_more: more, last_id: last } = body as { has_more?: unknown; last_id?: unknown };
      if (more !== true || typeof last !== 'string') break;
      afterId = last;
    }
    return models;
  };

  const provider = createAnthropic({
    apiKey: options.apiKey,
    baseURL: `${baseUrl}/v1`,
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl as typeof fetch }),
  });

  return createAiSdkAdapter({
    type: 'anthropic',
    model: (modelId) => provider(modelId),
    check: () => statusFromProbe(probe),
    listModels: listAll,
  });
}
