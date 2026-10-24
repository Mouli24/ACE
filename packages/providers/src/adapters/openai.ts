import { createOpenAI } from '@ai-sdk/openai';

import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import {
  createAiSdkAdapter,
  embedOpenAiStyle,
  getJson,
  statusFromProbe,
  withImageGeneration,
  type FetchLike,
} from './ai-sdk.js';
import { openAiApiRoot, parseOpenAiModelList } from './openai-compatible.js';

/** OpenAI (FR-PRV-001). Same listing shape as any compatible server, different default host. */

export const OPENAI_BASE_URL = 'https://api.openai.com';

export interface OpenAiOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function createOpenAiAdapter(options: OpenAiOptions): ProviderAdapter {
  // A base URL that already ends in `/v1` is the root as it is [audit P-4].
  const apiRoot = openAiApiRoot(options.baseUrl ?? OPENAI_BASE_URL);

  const probe = async (): Promise<unknown> =>
    getJson({
      url: `${apiRoot}/models`,
      headers: { Authorization: `Bearer ${options.apiKey}` },
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const provider = createOpenAI({
    apiKey: options.apiKey,
    baseURL: apiRoot,
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl as typeof fetch }),
  });

  return createAiSdkAdapter({
    type: 'openai',
    model: (modelId) => provider.chat(modelId),
    // D402: `gpt-image-*`, `chatgpt-image-*` and `dall-e-*` answer on the images endpoint.
    image: (modelId) => provider.image(modelId),
    check: () => statusFromProbe(probe),
    listModels: async (): Promise<ModelInfo[]> =>
      parseOpenAiModelList(await probe()).map(withImageGeneration),
    embed: (texts, embedOptions) =>
      embedOpenAiStyle(
        apiRoot,
        { Authorization: `Bearer ${options.apiKey}` },
        options.fetchImpl,
        texts,
        embedOptions,
      ),
  });
}
