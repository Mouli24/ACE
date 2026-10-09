import { DEFAULT_CLI_PERMISSION, type Model, type Provider, type ProviderType } from '@ace/contracts';
import type { ModelInfo, ProviderAdapter, ProviderAdapterFactory, ProviderDetection } from '@ace/engine';

import { createAnthropicAdapter } from './adapters/anthropic.js';
import { createClaudeCodeAdapter } from './adapters/cli/claude-code.js';
import { createCodexAdapter } from './adapters/cli/codex.js';
import { createCliDetector, type CliDetector } from './adapters/cli/detect.js';
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
  /** X1: the terminal scan; tests inject a fake so `pnpm test` never runs a real CLI. */
  cliDetector?: CliDetector;
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
  const cli = options.cliDetector ?? createCliDetector();

  return {
    create(provider: Provider, apiKey: string | undefined): ProviderAdapter {
      switch (provider.type) {
        case 'mock':
          // Its own view of the shared mock: §2.6's check reads this row (D-025), while the call
          // log still spans the whole run.
          return mock.forProvider({
            ...(apiKey === undefined ? {} : { apiKey }),
            ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
          });

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

        case 'claude_code':
          return createClaudeCodeAdapter({
            permission: provider.cliPermission ?? DEFAULT_CLI_PERMISSION,
            detect: () => cli.detect('claude_code'),
          });

        case 'codex_cli':
          return createCodexAdapter({
            permission: provider.cliPermission ?? DEFAULT_CLI_PERMISSION,
            detect: () => cli.detect('codex_cli'),
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

    // The Add-provider scan is always fresh; health checks read the 60 s cache.
    detectClis: () => cli.detectAll({ force: true }),
  };
}
