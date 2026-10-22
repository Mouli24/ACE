import type {
  CliDetectResponse,
  DataType,
  Model,
  ModelPricing,
  Part,
  Provider,
  ProviderState,
  ProviderType,
  ReasoningEffort,
  ToolDefinition,
  WorkspaceAccess,
} from '@ace/contracts';

/**
 * The model-serving port (Arch §7, §14.2).
 *
 * The contract lives here, with the other ports, because `packages/engine` may import only
 * `@ace/contracts` and its own ports (CLAUDE.md §3.4 rule 3). `@ace/providers` implements it and
 * re-exports these types, so `ProviderAdapter` is still what `packages/providers/src/adapter.ts`
 * hands out — there is simply one declaration of it rather than two that could drift.
 */

export interface ProviderStatus {
  status: ProviderState;
  message?: string;
  latencyMs?: number;
}

/** One model as a provider describes it, before the catalog gives it a row id. */
export interface ModelInfo {
  modelId: string;
  displayName: string;
  inputTypes: DataType[];
  outputTypes: DataType[];
  contextWindow: number;
  supportsTools: boolean;
  supportsJson: boolean;
  pricing?: ModelPricing;
  /**
   * False for a model the provider names but cannot serve right now — a CLI listing a model its
   * installed version is too old for. Absent means available.
   */
  available?: boolean;
  /** Why it is unavailable, in the provider's own words. */
  unavailableReason?: string;
  /** The provider's one-line description. */
  description?: string;
  /** What an alias resolves to today (`opus` → `claude-opus-5-5`), when the provider says. */
  resolvedModelId?: string;
  /** PG-1.4 (D359): the model's size on disk, when a local service reports it (Ollama tags). */
  sizeBytes?: number;
}

export const FINISH_REASONS = ['stop', 'length', 'refusal', 'tool_calls', 'error'] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

/** One tool result fed back into a continuation call after the executor ran a `tool_call` (round 4 §2.6). */
export interface ToolResult {
  callId: string;
  name: string;
  /** The arguments the model called the tool with, so an adapter can replay its call (X1 §4.4). */
  args?: unknown;
  /** Whatever the tool returned; the executor labels it untrusted before it reaches the model (FR-TOOL-010). */
  result: unknown;
}

/**
 * One finished turn of a node's own tool loop, in a format no provider owns (agentic nodes, D377):
 * what the model said, every call it made — parallel calls stay together — and what each returned.
 *
 * `opaque` is the provider's own record of the same turn, from its `opaque` chunk. An adapter of
 * that `providerType` replays it verbatim, which is what carries reasoning and its signatures back
 * (Anthropic thinking, Gemini `thoughtSignature`); any other adapter rebuilds the turn from the
 * neutral fields. Nothing outside the adapter reads inside `payload`, and an adapter checks its
 * shape before replaying it — a payload it does not recognise is rebuilt, never sent.
 *
 * The executor's contract, which every provider relies on: every call in `toolCalls` has exactly
 * one entry in `results` with the same `callId` — a call the executor refused, blocked, timed out
 * or dropped still gets a result saying so — and a turn with results always carries the calls they
 * answer. A provider rejects a call with no result, and a result with no call, outright.
 */
export interface AgentTurn {
  /** What the model said this turn alongside its calls; `''` when it only called tools. */
  text: string;
  /** Every call the model made this turn, in the order it made them. */
  toolCalls: { callId: string; name: string; args: unknown }[];
  /** What the executor got back for this turn's calls (FR-TOOL-010: labelled untrusted on replay). */
  results: ToolResult[];
  opaque?: { providerType: ProviderType; payload: unknown };
}

/**
 * What the executor hands an adapter. The prompt is already assembled (Arch §12.5) — an adapter
 * never builds one. The only message list is `turns`, which exists only inside one node's own tool
 * loop (D377); what crosses between nodes is governed by BR-02 — envelopes only, never a history.
 */
export interface GenerateRequest {
  modelId: string;
  /** The `## System` section, when the provider takes one separately from the prompt. */
  system?: string;
  prompt: string;
  outputTypes: DataType[];
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  /**
   * D389: the node's reasoning effort. Absent means the provider's default — an adapter sends
   * nothing then, so the call is what it was before. An adapter with no such control ignores it.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * The tools the agent has enabled for this call (round 4 §2.6, FR-TOOL-003). When present, an
   * adapter that supports tools may answer with `tool_call` chunks instead of a final answer; when
   * absent or empty, the model is being asked to finish without tools.
   */
  tools?: ToolDefinition[];
  /**
   * Results of the tools the executor ran for the previous turn's `tool_call` chunks, fed back so
   * the model can continue (Arch §12.7). An adapter reads these to decide whether to call another
   * tool or produce a final answer. Chat and non-agentic nodes send these; `turns` supersedes them.
   */
  toolResults?: ToolResult[];
  /**
   * D377: an agent node's turns so far, oldest first — when present it supersedes `toolResults`,
   * and an empty list is a first turn. An adapter replays each as one assistant message holding the
   * turn's words and all its calls, then one message with all its results ({@link AgentTurn}).
   */
  turns?: AgentTurn[];
  /**
   * Which run and which loop iteration this call belongs to. Optional and never needed to produce
   * an answer — adapters use them for tracing, and the mock keys its per-run behaviours on them.
   */
  runId?: string;
  iteration?: number;
  /**
   * D302: the chat turn this call belongs to. A direct chat belongs to no run (FR-CHAT-005), so a
   * provider keys per-call behaviour on this instead — the mock's attempt and script counters.
   */
  turnId?: string;
  /**
   * The project folder this call works in (X1 §4.2). Only an agent-route provider (a coding-agent
   * CLI) reads it; without it such a provider runs read-only in a fresh temp folder.
   */
  workingDir?: string;
  /**
   * D383: the workspace access this node asks of a coding-agent CLI, and the command prefixes it may
   * run (`agentWorkspaceOf(config).allowedCommands`). Only a CLI adapter reads it. Absent, or
   * `access: 'off'`, the provider's own `cliPermission` preset applies exactly as before. With no
   * `workingDir` the adapter still runs read-only in a throwaway folder, whatever is asked here.
   */
  cliAccess?: { access: WorkspaceAccess; allowedCommands: string[] };
}

/**
 * A `Part` a model produced (round 4 §2.6 `mock-media`, FR-MM-003, D216), with the bytes behind it
 * when it is media the provider generated.
 *
 * `bytes` sit *beside* the Part, never inside it: the Part stays a reference (its `artifactId` a
 * placeholder the engine replaces once it has stored the bytes as an artifact), so an envelope, an
 * event or a node run never carries them (FR-MM-004, BR-02, D204). Only the engine's
 * `ArtifactMaterialiser` reads them. A media Part without `bytes` must reference an artifact that is
 * already stored — there is nothing else to back it with (D-082).
 */
export interface ProducedPart {
  part: Part;
  bytes?: Uint8Array;
}

/**
 * One piece of a streamed answer.
 *
 * `text` and `json` carry a final answer; `tool_call` is a request the executor must satisfy and
 * feed back as a `ToolResult` (round 4 §2.6, Arch §12.7); `part` lets an adapter emit a produced
 * `Part` of any of the seven data types — for media, the reference plus the generated bytes the
 * engine stores as an artifact ({@link ProducedPart}, FR-MM-003), never the bytes inside the Part
 * (FR-MM-004, BR-02).
 */
export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'json'; value: unknown }
  | { type: 'tool_call'; callId: string; name: string; args: unknown }
  | ({ type: 'part' } & ProducedPart)
  /**
   * What the provider reported the call used (D313). `tokensIn` includes cached input;
   * `cachedTokensIn` is the part of it read from the provider's cache, when it says. A provider
   * that reports nothing yields no usage chunk at all, and the executor estimates the turn.
   */
  | {
      type: 'usage';
      tokensIn: number;
      tokensOut: number;
      costUsd?: number;
      cachedTokensIn?: number;
    }
  /**
   * Something the provider did itself — a CLI's command, file edit or read (X1 §4.2, D261). The
   * executor records it as a ToolCall; no guardrail runs, because it has already happened.
   */
  | {
      type: 'activity';
      tool: string;
      args: unknown;
      status: 'ok' | 'error';
      summary: string;
      durationMs: number;
    }
  /**
   * The model the provider says is actually serving this call — what an alias such as `opus`
   * resolved to. Recorded as `ModelUsed.resolvedModelId`; it changes nothing about the answer.
   */
  | { type: 'model'; modelId: string }
  /**
   * D377: the provider's own record of the turn that just ended — for the AI SDK, its assistant
   * messages with reasoning and signatures still on them. Yielded once, after the turn's content and
   * before its `usage` and `finish`, by an adapter that can replay it, and only for a request that
   * carries `turns` (a chat or non-agentic call never gets one); kept as that turn's
   * `AgentTurn.opaque` for the node's next call. It never leaves the node (BR-02), and nothing but
   * an adapter of `providerType` reads `payload`.
   */
  | { type: 'opaque'; providerType: ProviderType; payload: unknown }
  | { type: 'finish'; reason: FinishReason };

export interface ProviderAdapter {
  type: ProviderType;
  check(): Promise<ProviderStatus>;
  listModels(): Promise<ModelInfo[]>;
  generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
  embed?(texts: string[], options?: { modelId?: string }): Promise<number[][]>;
}

/** What a local runtime probe found (FR-PRV-007). */
export interface ProviderDetection {
  ollama?: { baseUrl: string; detected: boolean };
}

/** PG-1.4 (D359): what the engine found about the local Ollama runtime. */
export interface LocalRuntimeProbe {
  installed: boolean;
  running: boolean;
  /** True only for a server this engine started — one the person started is never stopped. */
  startedByAce: boolean;
  baseUrl: string;
  binaryPath?: string;
  version?: string;
  /** Why starting it failed. */
  error?: string;
}

/** One model Ollama holds in memory now (`/api/ps`). */
export interface LocalRunningModelInfo {
  modelId: string;
  sizeBytes?: number;
  sizeVramBytes?: number;
  expiresAt?: string;
}

/** One progress line of a pull (`/api/pull`'s NDJSON stream). */
export interface LocalPullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/**
 * PG-1.4 (D359): the local Ollama runtime, found, started and driven without a terminal. Only
 * `apps/server` binds it (to `@ace/providers`); the engine never spawns anything itself.
 */
export interface LocalModelControl {
  /** Installed? Answering? Never starts anything. */
  status(): Promise<LocalRuntimeProbe>;
  /** Start `ollama serve` when it is installed and not answering, then wait until it answers. */
  ensureRunning(): Promise<LocalRuntimeProbe>;
  /** Stop the server this engine started, if it did. Never one the person started. */
  stopOwned(): Promise<void>;
  running(baseUrl: string): Promise<LocalRunningModelInfo[]>;
  load(baseUrl: string, modelId: string): Promise<void>;
  unload(baseUrl: string, modelId: string): Promise<void>;
  /** Resolves when the pull finished; rejects with Ollama's reason when it failed. */
  pull(
    baseUrl: string,
    name: string,
    onProgress: (progress: LocalPullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * Builds an adapter for a stored provider row, and answers the two catalog questions the engine
 * cannot answer itself: what the manifest says, and what is running locally.
 *
 * `apps/server` is the only place that binds this to `@ace/providers`.
 */
export interface ProviderAdapterFactory {
  create(provider: Provider, apiKey: string | undefined): ProviderAdapter;
  /** Manifest entries for a provider type — empty when its models are always discovered. */
  manifestFor(type: ProviderType): ModelInfo[];
  /** Merge a provider's own listing with the manifest (FR-MOD-001, FR-MOD-002). */
  mergeCatalog(
    discovered: readonly ModelInfo[],
    manifest: readonly ModelInfo[],
  ): (ModelInfo & { source: Model['source'] })[];
  detect(): Promise<ProviderDetection>;
  /** X1 (FR-PRV-008): which coding-agent CLIs are installed and signed in. */
  detectClis?(): Promise<CliDetectResponse>;
  /** PG-1.4 (D359): the local Ollama runtime — absent where nothing local may be started. */
  local?: LocalModelControl;
}
