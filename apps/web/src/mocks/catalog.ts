import type { DataType, Model, Provider, ProviderState, ProviderType } from '@ace/contracts';

import { newId } from '../lib/ulid';

/**
 * The mock provider's catalogue, from round 2 §2.6 — the fixture both sides rely on. The engine
 * ships the real one in `packages/providers`; this is the same table so the UI can be built and
 * tested before A2 lands, and so a scenario means the same thing on both sides.
 */
interface CatalogEntry {
  modelId: string;
  displayName: string;
  inputTypes: DataType[];
  outputTypes: DataType[];
  contextWindow: number;
  supportsTools: boolean;
  supportsJson: boolean;
  available?: boolean;
}

export const MOCK_CATALOG: CatalogEntry[] = [
  {
    modelId: 'mock-text',
    displayName: 'Mock text',
    inputTypes: ['text'],
    outputTypes: ['text'],
    contextWindow: 8192,
    supportsTools: false,
    supportsJson: false,
  },
  {
    modelId: 'mock-slow',
    displayName: 'Mock slow stream',
    inputTypes: ['text'],
    outputTypes: ['text'],
    contextWindow: 8192,
    supportsTools: false,
    supportsJson: false,
  },
  {
    modelId: 'mock-json',
    displayName: 'Mock JSON',
    inputTypes: ['text', 'json'],
    outputTypes: ['json'],
    contextWindow: 8192,
    supportsTools: false,
    supportsJson: true,
  },
  {
    modelId: 'mock-bad-json',
    displayName: 'Mock malformed JSON',
    inputTypes: ['text'],
    outputTypes: ['json'],
    contextWindow: 8192,
    supportsTools: false,
    supportsJson: true,
  },
  {
    modelId: 'mock-503',
    displayName: 'Mock 503',
    inputTypes: ['text'],
    outputTypes: ['text'],
    contextWindow: 8192,
    supportsTools: false,
    supportsJson: false,
  },
  {
    modelId: 'mock-401',
    displayName: 'Mock auth error',
    inputTypes: ['text'],
    outputTypes: ['text'],
    contextWindow: 8192,
    supportsTools: false,
    supportsJson: false,
  },
  {
    modelId: 'mock-timeout',
    displayName: 'Mock timeout',
    inputTypes: ['text'],
    outputTypes: ['text'],
    contextWindow: 8192,
    supportsTools: false,
    supportsJson: false,
  },
  {
    modelId: 'mock-vision',
    displayName: 'Mock vision',
    inputTypes: ['text', 'image'],
    outputTypes: ['text'],
    contextWindow: 8192,
    supportsTools: false,
    supportsJson: false,
  },
  {
    modelId: 'mock-retired',
    displayName: 'Mock retired',
    inputTypes: ['text'],
    outputTypes: ['text'],
    contextWindow: 4096,
    supportsTools: false,
    supportsJson: false,
    available: false,
  },
];

/** A small catalogue per cloud provider type, enough for the model picker and its filters. */
const CLOUD_CATALOG: Partial<Record<ProviderType, CatalogEntry[]>> = {
  anthropic: [
    {
      modelId: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      inputTypes: ['text', 'image'],
      outputTypes: ['text', 'json'],
      contextWindow: 200_000,
      supportsTools: true,
      supportsJson: true,
    },
    {
      modelId: 'claude-haiku-4-5',
      displayName: 'Claude Haiku 4.5',
      inputTypes: ['text'],
      outputTypes: ['text'],
      contextWindow: 200_000,
      supportsTools: true,
      supportsJson: true,
    },
  ],
  openai: [
    {
      modelId: 'gpt-mock-large',
      displayName: 'GPT mock large',
      inputTypes: ['text', 'image'],
      outputTypes: ['text', 'json'],
      contextWindow: 128_000,
      supportsTools: true,
      supportsJson: true,
    },
  ],
  google: [
    {
      modelId: 'gemini-mock-pro',
      displayName: 'Gemini mock Pro',
      inputTypes: ['text', 'image', 'video'],
      outputTypes: ['text'],
      contextWindow: 1_000_000,
      supportsTools: true,
      supportsJson: true,
    },
  ],
  ollama: [
    {
      modelId: 'llama-mock',
      displayName: 'Llama mock',
      inputTypes: ['text'],
      outputTypes: ['text'],
      contextWindow: 8192,
      supportsTools: false,
      supportsJson: false,
    },
  ],
  openai_compatible: [
    {
      modelId: 'local-mock',
      displayName: 'Local mock',
      inputTypes: ['text'],
      outputTypes: ['text'],
      contextWindow: 16_384,
      supportsTools: false,
      supportsJson: true,
    },
  ],
};

/** §2.6 pricing: the same numbers the engine's mock uses, so a cost shown here matches a real run. */
export const MOCK_PRICING = {
  inputPer1k: 0.001,
  outputPer1k: 0.002,
  priceTableVersion: 'mock-v1',
} as const;

export function catalogFor(provider: Provider, now: string): Model[] {
  const entries = provider.type === 'mock' ? MOCK_CATALOG : (CLOUD_CATALOG[provider.type] ?? []);
  return entries.map((entry) => ({
    id: newId(),
    providerId: provider.id,
    modelId: entry.modelId,
    displayName: entry.displayName,
    inputTypes: entry.inputTypes,
    outputTypes: entry.outputTypes,
    contextWindow: entry.contextWindow,
    supportsTools: entry.supportsTools,
    supportsJson: entry.supportsJson,
    available: entry.available ?? true,
    source: provider.type === 'mock' ? 'manifest' : 'discovered',
    lastCheckedAt: now,
    pricing: { ...MOCK_PRICING },
  }));
}

/**
 * §2.6 provider-level behaviour, so a test can produce every `ProviderState` deterministically:
 * `apiKey: 'bad'` → AUTH_FAILED, `'ratelimited'` → RATE_LIMITED, a `baseUrl` containing
 * "unreachable" → UNREACHABLE, otherwise CONNECTED.
 */
export function checkOutcome(
  apiKey: string | undefined,
  baseUrl: string | undefined,
): { status: ProviderState; message?: string } {
  if (apiKey === 'bad') return { status: 'AUTH_FAILED', message: 'The API key was rejected.' };
  if (apiKey === 'ratelimited')
    return { status: 'RATE_LIMITED', message: 'Rate limited; try again shortly.' };
  if (baseUrl?.includes('unreachable')) {
    return { status: 'UNREACHABLE', message: `Nothing answered at ${baseUrl}.` };
  }
  return { status: 'CONNECTED' };
}

/** FR-PRV-007: the mock engine reports Ollama as detected on its default port. */
export const DETECTED_OLLAMA = { baseUrl: 'http://127.0.0.1:11434', detected: true } as const;
