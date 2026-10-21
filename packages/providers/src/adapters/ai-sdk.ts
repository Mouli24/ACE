import type { ProviderType, ToolDefinition } from '@ace/contracts';
import { toolResultBlock } from '@ace/engine';
import {
  Output,
  jsonSchema,
  streamText,
  tool,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart,
  type ToolSet,
} from 'ai';

import {
  ProviderCallError,
  abortedCallError,
  mapProviderError,
  providerStateForError,
  statusToNodeError,
  type AgentTurn,
  type FinishReason,
  type GenerateRequest,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderStatus,
  type StreamChunk,
  type ToolResult,
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

/**
 * Well-known chat families and a realistic context window for each [audit P-2]. Every model in
 * them takes tools, a JSON schema and an image, so a discovered one is not treated as a text-only
 * 8k model until someone writes it into the manifest. Prices are never guessed: those stay the
 * manifest's alone.
 */
const CHAT_FAMILIES: readonly { family: RegExp; contextWindow: number }[] = [
  { family: /^claude-(?!2|instant)/, contextWindow: 200_000 },
  { family: /^gpt-4o/, contextWindow: 128_000 },
  { family: /^gpt-4\.1/, contextWindow: 1_047_576 },
  { family: /^gpt-5/, contextWindow: 400_000 },
  { family: /^o[34](?:-|$)/, contextWindow: 200_000 },
  { family: /^gemini-(?:1\.5|[2-9])/, contextWindow: 1_048_576 },
];

/** Variants inside those families that are not plain chat: realtime, audio, search, live, … */
const NOT_PLAIN_CHAT = /realtime|audio|search|live|transcribe|tts|deep-research|codex|image/i;

const FAMILY_OUTPUT_TYPES = ['text', 'json', 'code'] as const;

/**
 * A discovered model with its family's defaults, when its id names a well-known chat family —
 * bare (`gpt-4.1-mini`) or behind a gateway's vendor prefix (`openai/gpt-4.1-mini`). Only what
 * the listing left at the discovery defaults is raised; a model already unavailable is left alone.
 */
export function withFamilyDefaults(model: ModelInfo): ModelInfo {
  if (model.available === false) return model;
  const id = model.modelId.replace(/^[^/]+\//, '').toLowerCase();
  if (NOT_PLAIN_CHAT.test(id)) return model;
  const known = CHAT_FAMILIES.find((entry) => entry.family.test(id));
  if (known === undefined) return model;
  return {
    ...model,
    inputTypes: model.inputTypes.includes('image')
      ? model.inputTypes
      : [...model.inputTypes, 'image'],
    outputTypes: [...new Set([...model.outputTypes, ...FAMILY_OUTPUT_TYPES])],
    supportsTools: true,
    supportsJson: true,
    contextWindow:
      model.contextWindow === DISCOVERED_MODEL_DEFAULTS.contextWindow
        ? known.contextWindow
        : model.contextWindow,
  };
}

/**
 * Names that mark a model that does not chat — embedders, speech, transcription, image generation,
 * moderation [audit P-6]. A listing puts them beside the chat models with nothing else to tell
 * them apart.
 */
const NON_CHAT_NAME = /embed|whisper|tts|transcribe|dall-e|image|moderation|guard|orpheus/i;

/**
 * Why a listed model cannot be chosen for a node [audit P-6]. Availability is about nodes only: a
 * knowledge base still picks and embeds with such a model.
 */
export const NOT_A_CHAT_MODEL = 'Not a chat model: an agent or model node cannot use it.';

/** The model, kept in the catalogue but unavailable, with {@link NOT_A_CHAT_MODEL}. */
export function notAChatModel(model: ModelInfo): ModelInfo {
  return { ...model, available: false, unavailableReason: NOT_A_CHAT_MODEL };
}

/** The model as its name describes it: unavailable when the name says it does not chat. */
export function byChatName(model: ModelInfo): ModelInfo {
  return NON_CHAT_NAME.test(model.modelId) ? notAChatModel(model) : model;
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

/** D389: a node's reasoning effort as AI SDK 7's `reasoning` call option; `max` is its `xhigh`. */
export function aiSdkReasoning(
  effort: NonNullable<GenerateRequest['reasoningEffort']>,
): 'low' | 'medium' | 'high' | 'xhigh' {
  return effort === 'max' ? 'xhigh' : effort;
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

/** The most pages a paginated model listing is followed for — a guard, never a limit in practice. */
export const MAX_LIST_PAGES = 20;

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

/**
 * `POST {apiRoot}/embeddings` — OpenAI and every compatible server. `apiRoot` already carries the
 * version (`…/v1`), as `openAiApiRoot` reads it [audit P-4].
 */
export async function embedOpenAiStyle(
  apiRoot: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike | undefined,
  texts: string[],
  options: EmbedOptions | undefined,
): Promise<number[][]> {
  const model = requireEmbedModel(options);
  if (texts.length === 0) return [];
  const body = (await postJson({
    url: `${apiRoot}/embeddings`,
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

/** A call the model made, as an assistant message part (X1 §4.4). */
const toolCallPart = (callId: string, name: string, args: unknown): ToolCallPart => ({
  type: 'tool-call',
  toolCallId: callId,
  toolName: name,
  input: args ?? {},
});

/** What a call returned, as a `tool` message part (X1 §4.4). */
const toolResultPart = (result: ToolResult): ToolResultPart => ({
  type: 'tool-result',
  toolCallId: result.callId,
  toolName: result.name,
  output: { type: 'json', value: toJsonValue(result.result) },
});

/** A call, said in words, for a request that defines no tools (review I1). */
const calledText = (name: string, args: unknown): TextPart => ({
  type: 'text',
  text: `I called the tool ${name} with ${JSON.stringify(args ?? {})}.`,
});

/** A result, in words and still labelled untrusted (FR-TOOL-010), for a request with no tools. */
const resultText = (result: ToolResult): TextPart => ({
  type: 'text',
  text: toolResultBlock(result.name, result.result),
});

/**
 * The turns so far, rebuilt from the executor's tool results (X1 §4.4): the prompt, then each call
 * the model made and what it returned. `undefined` for a first turn, which stays a single prompt.
 *
 * With no tools on offer — the final turn after the call limit — the calls are replayed as plain
 * text instead (review I1): Anthropic rejects `tool_use`/`tool_result` blocks in a request that
 * defines no tools, and a text replay means the same thing to every provider. Each result keeps its
 * untrusted label (FR-TOOL-010), since it now sits in a user turn.
 *
 * Chat and non-agentic nodes still come through here; an agent node's `turns` go through
 * {@link messagesFor} instead (D377).
 */
export function continuationMessages(req: GenerateRequest, withTools = true): ModelMessage[] | undefined {
  if (req.toolResults === undefined || req.toolResults.length === 0) return undefined;
  const messages: ModelMessage[] = [{ role: 'user', content: req.prompt }];
  for (const result of req.toolResults) {
    if (!withTools) {
      messages.push({ role: 'assistant', content: [calledText(result.name, result.args)] });
      messages.push({ role: 'user', content: [resultText(result)] });
      continue;
    }
    messages.push({
      role: 'assistant',
      content: [toolCallPart(result.callId, result.name, result.args)],
    });
    messages.push({ role: 'tool', content: [toolResultPart(result)] });
  }
  return messages;
}

/** A turn's words, unless it said nothing — an empty or blank text block is rejected by some providers. */
const saidText = (turn: AgentTurn): TextPart[] =>
  turn.text.trim() === '' ? [] : [{ type: 'text', text: turn.text }];

/** A turn from its neutral fields: one assistant message with its words and all its calls. */
function rebuiltTurn(turn: AgentTurn): ModelMessage[] {
  const content: (TextPart | ToolCallPart)[] = [
    ...saidText(turn),
    ...turn.toolCalls.map((call) => toolCallPart(call.callId, call.name, call.args)),
  ];
  return content.length === 0 ? [] : [{ role: 'assistant', content }];
}

/** The part types a recorded assistant message may carry back into a call (D377). */
const REPLAYABLE_PART_TYPES: ReadonlySet<string> = new Set(['text', 'reasoning', 'tool-call', 'file']);

/** An assistant message whose content is text, or a list of parts of a replayable type. */
function isRecordedAssistantMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { role, content } = value as { role?: unknown; content?: unknown };
  if (role !== 'assistant') return false;
  if (typeof content === 'string') return true;
  return (
    Array.isArray(content) &&
    content.every((part: unknown) => {
      if (typeof part !== 'object' || part === null) return false;
      const type = (part as { type?: unknown }).type;
      return typeof type === 'string' && REPLAYABLE_PART_TYPES.has(type);
    })
  );
}

/**
 * The provider's recorded messages, when the payload is a non-empty list of nothing but replayable
 * assistant messages. It comes back from the engine through JSON and is never trusted as typed: any
 * other shape — a user or system message, a stray value — is `undefined`, and the turn is rebuilt
 * from its plain fields instead of failing the call or slipping in a message the model never sent.
 */
function recordedMessages(payload: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(payload) || payload.length === 0) return undefined;
  return payload.every(isRecordedAssistantMessage) ? (payload as ModelMessage[]) : undefined;
}

/**
 * One turn with tools on offer: the provider's own assistant messages when this adapter's type
 * recorded them, else one assistant message with the turn's words and all its calls — then one
 * `tool` message with all its results.
 */
function turnMessages(turn: AgentTurn, type: ProviderType): ModelMessage[] {
  const recorded =
    turn.opaque?.providerType === type ? recordedMessages(turn.opaque.payload) : undefined;
  // A copy: the payload is the stored turn's, and the results are appended below.
  const messages: ModelMessage[] = recorded !== undefined ? [...recorded] : rebuiltTurn(turn);
  if (turn.results.length > 0) {
    messages.push({ role: 'tool', content: turn.results.map(toolResultPart) });
  }
  return messages;
}

/**
 * One turn with no tools on offer (review I1): its words and calls in one assistant message, its
 * results in one user message, all as text. A recorded turn is not replayed — its tool-call parts
 * would be rejected exactly as a rebuilt one's would.
 */
function turnAsText(turn: AgentTurn): ModelMessage[] {
  const said = [...saidText(turn), ...turn.toolCalls.map((call) => calledText(call.name, call.args))];
  const messages: ModelMessage[] = said.length === 0 ? [] : [{ role: 'assistant', content: said }];
  if (turn.results.length > 0) {
    messages.push({ role: 'user', content: turn.results.map(resultText) });
  }
  return messages;
}

/**
 * The messages for one call (D377). With `turns`, an agent node's own history: the prompt, then
 * each turn as {@link turnMessages} replays it — verbatim from an `opaque` record this adapter's
 * `type` made, which is how Anthropic thinking signatures and Gemini `thoughtSignature`s round-trip,
 * otherwise rebuilt with every call of the turn in one message. With no tools on offer every turn is
 * text ({@link turnAsText}). Without `turns`, exactly {@link continuationMessages}, so chat and
 * non-agentic nodes send what they always sent. `undefined` means a single prompt.
 */
export function messagesFor(
  req: GenerateRequest,
  type: ProviderType,
  withTools = true,
): ModelMessage[] | undefined {
  if (req.turns === undefined) return continuationMessages(req, withTools);
  if (req.turns.length === 0) return undefined;
  const messages: ModelMessage[] = [{ role: 'user', content: req.prompt }];
  for (const turn of req.turns) {
    messages.push(...(withTools ? turnMessages(turn, type) : turnAsText(turn)));
  }
  return messages;
}

/**
 * Wrap a provider's AI SDK handle as a `ProviderAdapter`.
 *
 * Output is always streamed as text, even when the contract asks for JSON: the executor parses and
 * checks the result against the contract (FR-EXE-006), and streaming is what puts words on the
 * Canvas while the model is still thinking (FR-EXE-008). A `jsonSchema` is also handed to the model
 * as a JSON response format (D353), so a provider with structured output is held to it.
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
          const messages = messagesFor(req, options.type, tools !== undefined);
          const input = messages === undefined ? { prompt: req.prompt } : { messages };
          const result = streamText({
            model: options.model(req.modelId),
            ...(req.system === undefined ? {} : { system: req.system }),
            ...input,
            ...(tools === undefined ? {} : { tools }),
            /*
             * PG-2.1 (D353): a node's output contract reaches a provider with structured output as a
             * JSON response format in that schema. The executor still parses and checks the answer
             * (FR-EXE-006), so a provider that ignores the format falls back to the prompt's schema.
             */
            ...(req.jsonSchema === undefined
              ? {}
              : {
                  output: Output.object({
                    schema: jsonSchema(req.jsonSchema as Parameters<typeof jsonSchema>[0]),
                  }),
                }),
            ...(req.maxTokens === undefined ? {} : { maxOutputTokens: req.maxTokens }),
            ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
            // D389: the SDK's own reasoning option, mapped per provider by the SDK; a model that
            // cannot reason gets a warning, never an error. Unset, nothing is sent.
            ...(req.reasoningEffort === undefined
              ? {}
              : { reasoning: aiSdkReasoning(req.reasoningEffort) }),
            abortSignal: signal,
            // ACE owns the retry policy (Arch §28, round 3). Left at its default the SDK would
            // quietly re-send a 503 three times, which breaks the per-provider concurrency count
            // and hides the failure the engine is supposed to decide about.
            maxRetries: 0,
          });

          // The turn's trailer — usage, then finish — is held until the stream ends, so the turn's
          // `opaque` record can go out after its content and before it (D377, FR-EXE-008).
          let usage: Extract<StreamChunk, { type: 'usage' }> | undefined;
          let finish: FinishReason | undefined;

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
                usage = {
                  type: 'usage',
                  tokensIn: inputTokens ?? 0,
                  tokensOut: outputTokens ?? 0,
                  ...(cached > 0 ? { cachedTokensIn: cached } : {}),
                };
              }
              finish = toFinishReason(part.finishReason);
            }
          }

          if (finish !== undefined) {
            /*
             * D377: the turn as the provider recorded it, for the node's next call to replay — only
             * for a request that carries `turns`, the one kind that can send it back; chat and
             * non-agentic calls neither wait for it nor carry a copy. The AI SDK copies each part's
             * provider metadata onto its response messages as `providerOptions` — Anthropic's
             * thinking signature on the reasoning part, Gemini's `thoughtSignature` on the call part.
             */
            if (req.turns !== undefined) {
              const recorded = (await result.response).messages.filter(
                (message) => message.role === 'assistant',
              );
              if (recorded.length > 0) {
                yield { type: 'opaque', providerType: options.type, payload: recorded };
              }
            }
            if (usage !== undefined) yield usage;
            yield { type: 'finish', reason: finish };
          }
        } catch (error) {
          throw new ProviderCallError(mapProviderError(error, { signal }));
        }
      })();
    },
  };
}
