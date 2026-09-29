import type { ProviderType } from '@ace/contracts';
import { streamText, type LanguageModel } from 'ai';

import {
  ProviderCallError,
  abortedCallError,
  mapProviderError,
  providerStateForError,
  statusToNodeError,
  type FinishReason,
  type GenerateRequest,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderStatus,
  type StreamChunk,
} from '../adapter.js';

/**
 * The half of every real adapter that is the same everywhere (Arch §14.2): streaming through the
 * Vercel AI SDK, and turning an HTTP failure into an ACE error kind.
 *
 * Each provider then supplies only what is genuinely its own — which endpoint says "are you
 * there", how the key is carried, and how its model listing is shaped.
 */

/** Defaults for a model nobody has described yet; the catalog manifest overrides them. */
export const DISCOVERED_MODEL_DEFAULTS = {
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 8192,
  supportsTools: false,
  supportsJson: false,
} as const;

export function discoveredModel(modelId: string, displayName?: string): ModelInfo {
  return {
    modelId,
    displayName: displayName ?? modelId,
    inputTypes: [...DISCOVERED_MODEL_DEFAULTS.inputTypes],
    outputTypes: [...DISCOVERED_MODEL_DEFAULTS.outputTypes],
    contextWindow: DISCOVERED_MODEL_DEFAULTS.contextWindow,
    supportsTools: DISCOVERED_MODEL_DEFAULTS.supportsTools,
    supportsJson: DISCOVERED_MODEL_DEFAULTS.supportsJson,
  };
}

/** The AI SDK's finish reasons, narrowed to ours (Arch §14.2). */
function toFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'refusal';
    case 'tool-calls':
      return 'tool_calls';
    default:
      return 'error';
  }
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface HttpProbeOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** How long a `check()` waits before calling a provider unreachable. */
export const CHECK_TIMEOUT_MS = 10_000;

/**
 * One GET, turned into either a parsed body or a `ProviderCallError`. Every real adapter's
 * `check()` and `listModels()` go through this, so they cannot disagree about what a 401 means.
 */
export async function getJson(options: HttpProbeOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? CHECK_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(options.url, { headers: options.headers ?? {}, signal });
  } catch (error) {
    // A timeout on a reachability probe is the provider being unreachable, not the user
    // cancelling: the signal is one this function created, so its abort can only be the timer.
    throw new ProviderCallError(
      signal.aborted
        ? {
            kind: 'network',
            code: 'timeout',
            message: `The provider did not answer within ${options.timeoutMs ?? CHECK_TIMEOUT_MS} ms.`,
            retryable: true,
          }
        : mapProviderError(error),
    );
  }

  if (!response.ok) {
    throw new ProviderCallError(statusToNodeError(response.status, await errorText(response)));
  }

  return response.json();
}

async function errorText(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null) {
      const error = (body as { error?: unknown }).error;
      if (typeof error === 'string') return error;
      if (typeof error === 'object' && error !== null) {
        const message = (error as { message?: unknown }).message;
        if (typeof message === 'string') return message;
      }
    }
    return JSON.stringify(body);
  } catch {
    return response.statusText;
  }
}

/**
 * Run a probe and report it as a `ProviderStatus` (FR-PRV-003). A failure never throws here —
 * "I could not reach it" is a perfectly good answer to "are you there".
 */
export async function statusFromProbe(
  probe: () => Promise<unknown>,
  now: () => number = () => Date.now(),
): Promise<ProviderStatus> {
  const startedAt = now();
  try {
    await probe();
    return { status: 'CONNECTED', latencyMs: now() - startedAt };
  } catch (error) {
    const nodeError = mapProviderError(error);
    return {
      status: providerStateForError(nodeError),
      message: nodeError.message,
      latencyMs: now() - startedAt,
    };
  }
}

export interface AiSdkAdapterOptions {
  type: ProviderType;
  /** Builds the AI SDK model handle for one model id. */
  model: (modelId: string) => LanguageModel;
  check: () => Promise<ProviderStatus>;
  listModels: () => Promise<ModelInfo[]>;
  embed?: (texts: string[]) => Promise<number[][]>;
}

/**
 * Wrap a provider's AI SDK handle as a `ProviderAdapter`.
 *
 * Output is always streamed as text, even when the contract asks for JSON: the executor parses and
 * checks the result against the contract (FR-EXE-006), and streaming is what puts words on the
 * Canvas while the model is still thinking (FR-EXE-008).
 */
export function createAiSdkAdapter(options: AiSdkAdapterOptions): ProviderAdapter {
  return {
    type: options.type,
    check: options.check,
    listModels: options.listModels,
    ...(options.embed === undefined ? {} : { embed: options.embed }),

    generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
      return (async function* (): AsyncGenerator<StreamChunk> {
        try {
          const result = streamText({
            model: options.model(req.modelId),
            ...(req.system === undefined ? {} : { system: req.system }),
            prompt: req.prompt,
            ...(req.maxTokens === undefined ? {} : { maxOutputTokens: req.maxTokens }),
            ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
            abortSignal: signal,
            // ACE owns the retry policy (Arch §28, round 3). Left at its default the SDK would
            // quietly re-send a 503 three times, which breaks the per-provider concurrency count
            // and hides the failure the engine is supposed to decide about.
            maxRetries: 0,
          });

          // `fullStream` rather than `textStream`: a failed call ends `textStream` silently and
          // only surfaces as a NoOutputGeneratedError with no cause, which would throw away the
          // status code every Arch §28 rule depends on.
          for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
              yield { type: 'text', delta: part.text };
              continue;
            }

            if (part.type === 'error') {
              throw new ProviderCallError(mapProviderError(part.error, { signal }));
            }

            // An aborted call does not throw: the SDK emits `abort` and ends the stream quietly,
            // which would read as a finished answer — whether the transport failed before the first
            // byte or mid-stream. Why it was aborted is the signal's reason: a timeout (`network`,
            // retried) or a stop (`user_cancelled`) (D97, D109).
            if (part.type === 'abort') {
              throw new ProviderCallError(abortedCallError(undefined, { signal }));
            }

            if (part.type === 'finish') {
              yield {
                type: 'usage',
                tokensIn: part.totalUsage.inputTokens ?? 0,
                tokensOut: part.totalUsage.outputTokens ?? 0,
              };
              yield { type: 'finish', reason: toFinishReason(part.finishReason) };
            }
          }
        } catch (error) {
          throw new ProviderCallError(mapProviderError(error, { signal }));
        }
      })();
    },
  };
}
