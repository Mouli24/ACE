import type { Model, Provider, ProviderType } from '@ace/contracts';
import type { ModelInfo, ProviderAdapter, ProviderAdapterFactory, ProviderDetection } from '@ace/engine';

import { createAnthropicAdapter } from './adapters/anthropic.js';
import { createGoogleAdapter } from './adapters/google.js';
import { createMockAdapter, type MockProviderAdapter } from './adapters/mock.js';
import { createOllamaAdapter, detectOllama, DEFAULT_OLLAMA_BASE_URL } from './adapters/ollama.js';
import { createOpenAiAdapter } from './adapters/openai.js';
import { createOpenAiCompatibleAdapter } from './adapters/openai-compatible.js';
import { manifestFor, mergeCatalog } from './catalog/index.js';

/**
 * The one place a stored provider row becomes a live adapter — the implementation of the
 * `ProviderAdapterFactory` port (Arch §7, §14.1). `apps/server` binds it; nothing else does.
 */

export interface ProviderFactoryOptions {
  /** Injected by tests, so a mock provider's call log and clock are reachable from outside. */
  mock?: MockProviderAdapter;
  fetchImpl?: typeof fetch;
}

/** Thrown when a provider row asks for a type this build has no adapter for. */
export class UnknownProviderTypeError extends Error {
  override readonly name = 'UnknownProviderTypeError';

  constructor(type: string) {
    super(`No adapter is registered for provider type "${type}".`);
  }
}

export function createProviderAdapterFactory(
  options: ProviderFactoryOptions = {},
): ProviderAdapterFactory {
  // One shared mock per engine, so `calls()` spans a whole run rather than one dispatch.
  const mock = options.mock ?? createMockAdapter();
  const fetchImpl = options.fetchImpl;

  return {
    create(provider: Provider, apiKey: string | undefined): ProviderAdapter {
      switch (provider.type) {
        case 'mock':
          return mock;

        case 'anthropic':
          return createAnthropicAdapter({
            apiKey: apiKey ?? '',
            ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          });

        case 'google':
          return createGoogleAdapter({
            apiKey: apiKey ?? '',
            ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          });

        case 'openai':
          return createOpenAiAdapter({
            apiKey: apiKey ?? '',
            ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          });

        case 'openai_compatible':
          return createOpenAiCompatibleAdapter({
            baseUrl: provider.baseUrl ?? '',
            ...(apiKey === undefined ? {} : { apiKey }),
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          });

        case 'ollama':
          return createOllamaAdapter({
            baseUrl: provider.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
            ...(fetchImpl === undefined ? {} : { fetchImpl }),
          });

        default:
          throw new UnknownProviderTypeError(provider.type);
      }
    },

    manifestFor: (type: ProviderType): ModelInfo[] => manifestFor(type),

    mergeCatalog: (discovered, manifest): (ModelInfo & { source: Model['source'] })[] =>
      mergeCatalog(discovered, manifest.map((model) => ({ ...model, pricing: model.pricing ?? { inputPer1k: 0, outputPer1k: 0, priceTableVersion: 'unpriced' } }))),

    detect: async (): Promise<ProviderDetection> => ({
      ollama: await detectOllama(DEFAULT_OLLAMA_BASE_URL, fetchImpl),
    }),
  };
}
