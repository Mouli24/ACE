import { DEFAULT_CLI_PERMISSION, type Model, type Provider, type ProviderType } from '@ace/contracts';
import type {
  LocalModelControl,
  ModelInfo,
  ProviderAdapter,
  ProviderAdapterFactory,
  ProviderDetection,
} from '@ace/engine';

import { createAnthropicAdapter } from './adapters/anthropic.js';
import { createClaudeCodeAdapter } from './adapters/cli/claude-code.js';
import { createCodexAdapter } from './adapters/cli/codex.js';
import { createGeminiAdapter } from './adapters/cli/gemini.js';
import { createCliDetector, type CliDetector } from './adapters/cli/detect.js';
import type { ResolvedCommand } from './adapters/cli/resolve.js';
import { createGoogleAdapter } from './adapters/google.js';
import { createMockAdapter, type MockProviderAdapter } from './adapters/mock.js';
import { createOllamaAdapter, detectOllama, DEFAULT_OLLAMA_BASE_URL } from './adapters/ollama.js';
import { createOllamaRuntime } from './adapters/ollama-runtime.js';
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
  /**
   * Finds a CLI's binary for a call or a model listing — `PATH` by default. Tests inject one so a
   * model listing never starts the real CLI (D286).
   */
  cliResolve?: (bin: string) => ResolvedCommand | undefined;
  /**
   * PG-1.4 (D359): the local Ollama runtime — found, started and driven without a terminal. The
   * default finds the real one; `false` leaves the factory without one.
   */
  localRuntime?: LocalModelControl | false;
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
  const cliResolve = options.cliResolve;
  const local =
    options.localRuntime === false
      ? undefined
      : (options.localRuntime ?? createOllamaRuntime(fetchImpl === undefined ? {} : { fetchImpl }));

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
            ...(cliResolve === undefined ? {} : { resolve: () => cliResolve('claude') }),
          });

        case 'codex_cli':
          return createCodexAdapter({
            permission: provider.cliPermission ?? DEFAULT_CLI_PERMISSION,
            detect: () => cli.detect('codex_cli'),
            ...(cliResolve === undefined ? {} : { resolve: () => cliResolve('codex') }),
          });

        case 'gemini_cli':
          return createGeminiAdapter({
            permission: provider.cliPermission ?? DEFAULT_CLI_PERMISSION,
            detect: () => cli.detect('gemini_cli'),
            ...(cliResolve === undefined ? {} : { resolve: () => cliResolve('gemini') }),
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

    ...(local === undefined ? {} : { local }),
  };
}
