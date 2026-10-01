import { createOpenAI } from '@ai-sdk/openai';

import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import {
  createAiSdkAdapter,
  embedOpenAiStyle,
  getJson,
  statusFromProbe,
  type FetchLike,
} from './ai-sdk.js';
import { parseOpenAiModelList } from './openai-compatible.js';

/** OpenAI (FR-PRV-001). Same listing shape as any compatible server, different default host. */

export const OPENAI_BASE_URL = 'https://api.openai.com';

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function createOpenAiAdapter(options: OpenAiOptions): ProviderAdapter {
  const baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '');

  const probe = async (): Promise<unknown> =>
    getJson({
      url: `${baseUrl}/v1/models`,
      headers: { Authorization: `Bearer ${options.apiKey}` },
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const provider = createOpenAI({
    apiKey: options.apiKey,
    baseURL: `${baseUrl}/v1`,
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl as typeof fetch }),
  });

  return createAiSdkAdapter({
    type: 'openai',
    model: (modelId) => provider.chat(modelId),
    check: () => statusFromProbe(probe),
    listModels: async (): Promise<ModelInfo[]> => parseOpenAiModelList(await probe()),
    embed: (texts, embedOptions) =>
      embedOpenAiStyle(
        baseUrl,
        { Authorization: `Bearer ${options.apiKey}` },
        options.fetchImpl,
        texts,
        embedOptions,
      ),
  });
}
