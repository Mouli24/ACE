import type { ProviderAdapter } from '../adapter.js';
import { getJson, type FetchLike } from './ai-sdk.js';
import { createOpenAiCompatibleAdapter, normaliseBaseUrl } from './openai-compatible.js';

/**
 * Ollama (FR-PRV-007). It speaks the OpenAI API, so this is `openai_compatible` with the local
 * address filled in and a probe the engine can run before the user has added anything.
 */

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export interface OllamaOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export function createOllamaAdapter(options: OllamaOptions = {}): ProviderAdapter {
  return createOpenAiCompatibleAdapter({
    type: 'ollama',
    baseUrl: normaliseBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}

/** How long detection waits. Short: this runs on first load and must never hold the UI up. */
export const DETECT_TIMEOUT_MS = 1_000;

export interface OllamaDetection {
  baseUrl: string;
  detected: boolean;
}

/**
 * `GET /providers/detect` (FR-PRV-007, TC-PRV-008). Never throws — "nothing answered" is the
 * expected outcome on a machine without Ollama, not an error worth reporting.
 */
export async function detectOllama(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
  fetchImpl?: FetchLike,
): Promise<OllamaDetection> {
  const url = normaliseBaseUrl(baseUrl);
  try {
    await getJson({
      url: `${url}/v1/models`,
      timeoutMs: DETECT_TIMEOUT_MS,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    });
    return { baseUrl: url, detected: true };
  } catch {
    return { baseUrl: url, detected: false };
  }
}
