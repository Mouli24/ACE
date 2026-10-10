import type { ProviderType, ToolDefinition } from '@ace/contracts';
import { toolResultBlock } from '@ace/engine';
import {
  jsonSchema,
  streamText,
  tool,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';

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

export interface EmbedOptions {
  modelId?: string;
}

/** How long one embedding batch may take. Longer than a probe: a batch is real work. */
export const EMBED_TIMEOUT_MS = 60_000;

/** An embedding call without a model is a programming error, not a provider failure. */
export function requireEmbedModel(options: EmbedOptions | undefined): string {
  const modelId = options?.modelId;
  if (modelId === undefined || modelId === '') {
    throw new Error('embed() needs options.modelId: an embedding call must name its model.');
  }
  return modelId;
}

export interface HttpPostOptions {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** One POST of JSON, with the same failure classification as `getJson` (D57/D58). */
export async function postJson(options: HttpPostOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? EMBED_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
      body: JSON.stringify(options.body),
      signal,
    });
  } catch (error) {
    throw new ProviderCallError(
      signal.aborted
        ? {
            kind: 'network',
            code: 'timeout',
            message: `The provider did not answer within ${timeoutMs} ms.`,
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

/** A malformed embedding answer is a provider fault that retrying will not fix. */
export function badEmbedResponse(what: string): ProviderCallError {
  return new ProviderCallError({
    kind: 'provider',
    code: 'bad_embedding_response',
    message: `The provider's embedding response was malformed: ${what}.`,
    retryable: false,
  });
}

/** Check a parsed vector list against the number of texts sent. */
export function checkVectors(vectors: unknown[], expected: number): number[][] {
  if (vectors.length !== expected) {
    throw badEmbedResponse(`expected ${expected} vectors, got ${vectors.length}`);
  }
  return vectors.map((vector) => {
    if (!Array.isArray(vector) || !vector.every((n) => typeof n === 'number')) {
      throw badEmbedResponse('a vector is not a list of numbers');
    }
    return vector as number[];
  });
}

/** `POST {baseUrl}/v1/embeddings` — OpenAI and every compatible server. */
export async function embedOpenAiStyle(
  baseUrl: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike | undefined,
  texts: string[],
  options: EmbedOptions | undefined,
): Promise<number[][]> {
  const model = requireEmbedModel(options);
  if (texts.length === 0) return [];
  const body = (await postJson({
    url: `${baseUrl}/v1/embeddings`,
    headers,
    body: { model, input: texts },
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  })) as { data?: unknown };
  if (!Array.isArray(body.data)) throw badEmbedResponse('no "data" list');
  const rows = [...(body.data as { index?: number; embedding?: unknown }[])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  return checkVectors(
    rows.map((row) => row.embedding),
    texts.length,
  );
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
  embed?: (texts: string[], options?: EmbedOptions) => Promise<number[][]>;
}

/**
 * ACE's enabled tools, offered **without** `execute` (X1 §4.4): the SDK surfaces the model's call as
 * a `tool-call` part and ACE's own loop runs it, under the tool-point guardrails and approvals
 * (Arch §12.7). The SDK never runs a tool itself.
 */
export function toToolSet(tools: readonly ToolDefinition[] | undefined): ToolSet | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return Object.fromEntries(
    tools.map((definition) => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
      }),
    ]),
  );
}

const toJsonValue = (value: unknown): JSONValue =>
  JSON.parse(JSON.stringify(value ?? null)) as JSONValue;

/**
 * The turns so far, rebuilt from the executor's tool results (X1 §4.4): the prompt, then each call
 * the model made and what it returned. `undefined` for a first turn, which stays a single prompt.
 *
 * With no tools on offer — the final turn after the call limit — the calls are replayed as plain
 * text instead (review I1): Anthropic rejects `tool_use`/`tool_result` blocks in a request that
 * defines no tools, and a text replay means the same thing to every provider. Each result keeps its
 * untrusted label (FR-TOOL-010), since it now sits in a user turn.
 */
export function continuationMessages(req: GenerateRequest, withTools = true): ModelMessage[] | undefined {
  if (req.toolResults === undefined || req.toolResults.length === 0) return undefined;
  const messages: ModelMessage[] = [{ role: 'user', content: req.prompt }];
  for (const result of req.toolResults) {
    if (!withTools) {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `I called the tool ${result.name} with ${JSON.stringify(result.args ?? {})}.` }],
      });
      messages.push({ role: 'user', content: [{ type: 'text', text: toolResultBlock(result.name, result.result) }] });
      continue;
    }
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: result.callId, toolName: result.name, input: result.args ?? {} }],
    });
    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: result.callId,
          toolName: result.name,
          output: { type: 'json', value: toJsonValue(result.result) },
        },
      ],
    });
  }
  return messages;
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
          const tools = toToolSet(req.tools);
          const messages = continuationMessages(req, tools !== undefined);
          const input = messages === undefined ? { prompt: req.prompt } : { messages };
          const result = streamText({
            model: options.model(req.modelId),
            ...(req.system === undefined ? {} : { system: req.system }),
            ...input,
            ...(tools === undefined ? {} : { tools }),
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

            if (part.type === 'tool-call') {
              yield { type: 'tool_call', callId: part.toolCallId, name: part.toolName, args: part.input };
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
              // D313: a provider that reported no usage yields none, and the executor estimates.
              const { inputTokens, outputTokens, inputTokenDetails } = part.totalUsage;
              if (inputTokens !== undefined || outputTokens !== undefined) {
                const cached = inputTokenDetails?.cacheReadTokens ?? 0;
                yield {
                  type: 'usage',
                  tokensIn: inputTokens ?? 0,
                  tokensOut: outputTokens ?? 0,
                  ...(cached > 0 ? { cachedTokensIn: cached } : {}),
                };
              }
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
