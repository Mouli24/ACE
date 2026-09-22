import { createGoogleGenerativeAI } from '@ai-sdk/google';

import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import { createAiSdkAdapter, discoveredModel, getJson, statusFromProbe, type FetchLike } from './ai-sdk.js';

/**
 * Google Generative AI (FR-PRV-001). Its listing carries the key as a query parameter and names
 * models `models/<id>`, both of which are normalised here so the catalog sees plain ids.
 */

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com';

export interface GoogleOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function parseGoogleModelList(body: unknown): ModelInfo[] {
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  return models.flatMap((entry): ModelInfo[] => {
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== 'string') return [];
    const displayName = (entry as { displayName?: unknown }).displayName;
    return [
      discoveredModel(
        name.replace(/^models\//, ''),
        typeof displayName === 'string' ? displayName : undefined,
      ),
    ];
  });
}

export function createGoogleAdapter(options: GoogleOptions): ProviderAdapter {
  const baseUrl = (options.baseUrl ?? GOOGLE_BASE_URL).replace(/\/+$/, '');

  const probe = async (): Promise<unknown> =>
    getJson({
      url: `${baseUrl}/v1beta/models?key=${encodeURIComponent(options.apiKey)}`,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });

  const provider = createGoogleGenerativeAI({
    apiKey: options.apiKey,
    baseURL: `${baseUrl}/v1beta`,
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl as typeof fetch }),
  });

  return createAiSdkAdapter({
    type: 'google',
    model: (modelId) => provider(modelId),
    check: () => statusFromProbe(probe),
    listModels: async (): Promise<ModelInfo[]> => parseGoogleModelList(await probe()),
  });
}
