import {
  TOOL_CALL_ID_MAX,
  TOOL_RESULT_SUMMARY_MAX,
  agentToolNames,
  agentWorkspaceOf,
  effectiveOutputTypes,
  isAgentic,
  isCliProviderType,
  validateAgainstContract,
  type Envelope,
  type EnvelopeContract,
  type FailureReason,
  type Id,
  type Model,
  type MemoryOp,
  type ModelUsed,
  type NodeRunSource,
  type Node,
  type NodeError,
  type NodeState,
  type Part,
  type ToolCall,
  type ToolDefinition,
  type Usage,
  type Verdict,
} from '@ace/contracts';

import { createBatcher } from '../events/batcher.js';
import {
  classifyError,
  failureReasonFor,
  nodeStateFor,
  userCancelledError,
} from '../errors/index.js';
import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type {
  AgentTurn,
  ModelRouter,
  ProducedPart,
  ProviderAdapter,
  RouteResult,
  StreamChunk,
  ToolResult,
} from '../ports/index.js';
import { runRetrievalNode, withRetrieved } from '../knowledge/retrieval-node.js';
import type { SearchService } from '../knowledge/search.js';
import { extractMemoryOps, maskMemoryValue, withMemoryField } from '../memory/ops.js';
import {
  extractEnvelopeBlocks,
  type EnvelopeJudgement,
  type JudgedEnvelope,
} from '../domain/envelope-block.js';
import { isTurnAbortReason } from '../domain/run-domain.js';
import { estimateTokens } from '../envelopes/index.js';
import { maskSecrets } from '../security/secret-patterns.js';
import { assemblePrompt, type TeamPromptInput } from '../prompts/index.js';
import type { RunGate } from './control/gate.js';
import { createReplayAdapter, type ReplayAnswer } from './replay.js';
import { usageFor, withReportedCost, type PricedProvider } from './cost.js';
import {
  buildToolCall,
  resultText,
  summariseResult,
  toolResultBlock,
  withJudgedText,
  type ArtifactMaterialiser,
  type ToolGuardStep,
  type ToolPointInput,
  type ToolProvider,
} from './tool-loop.js';
import { runTransform } from './transform.js';
import {
  AGENT_DEFAULT_CONTEXT_WINDOW,
  CANCELLED_SUMMARY,
  agentSystemPrompt,
  backgroundProcessOf,
  checkLimits,
  deniedCommandResult,
  elideTurns,
  newAgentLoopState,
  skippedCallResult,
  toolTarget,
  withoutOpaque,
  type AgentLoopState,
} from './agentic/index.js';
import { changedPathsOf } from './agentic/summary.js';

/**
 * The node executor (FR-EXE-004..010, FR-EXE-015, Arch §12.2).
 *
 * One node run, start to finish: assemble, route, call, stream, check, price. Everything it
 * learns is returned rather than written — the scheduler owns the node run row and the run
 * totals, so there is one writer per row and no interleaving between concurrent nodes.
 */

/** Arch §24: stream frames are batched for about 50 ms before they reach a client. */
export const TOKEN_BATCH_MS = 50;

export interface ExecuteNodeInput {
  runId: Id;
  workflowId: Id;
  nodeRunId: Id;
  node: Node;
  envelopes: readonly Envelope[];
  iteration: number;
  attempt: number;
  /** What `StartRunRequest.inputs` supplied, keyed by Input node id (FR-NODE-011). */
  runInputs: Record<Id, Part[]>;
  signal: AbortSignal;
  /**
   * Called once, when the node starts doing its work: for an agent that is the moment it holds its
   * provider's concurrency slot, so a node queued behind the limit stays READY (D66, FR-PRV-009).
   */
  onStarted?: () => Promise<void>;
  /**
   * Called when an agent's provider call ends, still holding the slot — the moment its node run
   * ends, so node-run spans on one provider never overlap more than its limit allows (D66).
   */
  onEnded?: () => void;
  /**
   * The guardrail points for this node run, or absent when the app is built without a guardrail
   * engine — in which case nothing is checked and the executor validates the contract itself, the
   * round-2 behaviour.
   */
  guardrails?: NodeGuardrails;
  /**
   * FR-ERR-005: the validation reason of the attempt this one is repairing, appended to the
   * instructions. Set only on the single contract-repair retry (§2.1).
   */
  repairReason?: string;
  /**
   * The run's gate (FR-CTL-001, FR-CTL-002, D66, D111). An agent handed its provider slot while the
   * run is paused has not started — it is READY, which a pause turns PAUSED — so it hands the slot
   * straight back and waits for the resume. Absent, nothing holds it.
   */
  gate?: Pick<RunGate, 'isPaused' | 'waitUntilDispatchable'>;
  /**
   * Round 5: what an agent or Model node reads beyond its envelopes' own reads — retrieved chunks
   * and long-term memory — with the context guardrails over all of it (§2.2–§2.4, FR-GRD-004). The
   * scheduler builds it per node run; absent, the envelopes are read as delivered (round 4).
   */
  context?: NodeContextHook;
  /** Round 5: an agent's long-term memory (§2.2, FR-MEM-002); absent, no `__memory` is read. */
  memory?: NodeMemoryHook;
  /**
   * D311: the run's goal and what the human said to this node, as `## Team goal` and
   * `## Human instructions`. Agent and Model nodes only; absent, the prompt is unchanged.
   */
  team?: TeamPromptInput;
  /**
   * D310: the turn's envelope blocks are taken out of the answer and judged here, before the JSON
   * parse and the output point. Absent, the answer is left as it is.
   */
  teamEnvelopes?: NodeEnvelopeRules;
  /**
   * PG-5.4: this node run belongs to a replay. Its provider call — or a Retrieval node's search —
   * is answered from the source run's recording, never sent anywhere; `missing` fails the node
   * clearly instead. Absent on every other run.
   */
  replay?: ReplayAnswer;
}

/** How a turn's ```ace-envelope blocks are judged (D310): a refusal is a CONTRACT_VIOLATION. */
export interface NodeEnvelopeRules {
  judge(blocks: readonly string[]): EnvelopeJudgement;
}

/**
 * The context hook (round 5 §2.2–§2.4, F4). Called once per node run, for agent and Model nodes,
 * before the input point and prompt assembly, so what it places is what the input point checks and
 * the prompt shows. A `failed` step fails the node with its own reason — `GUARDRAIL_VIOLATION` for a
 * block, `BLOCKED` for a base deleted mid-run. It is handed the run's abort signal (13a review m3), so a
 * Stop cuts a slow search short and the node ends STOPPED with nothing more recorded.
 */
export interface NodeContextHook {
  build(
    envelopes: readonly Envelope[],
    signal: AbortSignal,
  ): Promise<
    GuardrailStep<{
      envelopes: Envelope[];
      /** The chunks placed, best first (FR-RAG-007). */
      sources: NodeRunSource[];
      /** The chunks the search found that did not fit, lowest score first. */
      droppedSources: NodeRunSource[];
      /** The memory entries placed. */
      usedMemoryIds: Id[];
    }>
  >;
  /**
   * The context point over one tool result, before the model reads it (round 5 §2.3, FR-GRD-004):
   * hidden instructions stripped and PII redacted per the policy, its verdicts recorded on the node
   * run. A `failed` step ends the node with its reason — `GUARDRAIL_VIOLATION`. Absent, the result
   * goes back as round 4 sent it.
   */
  toolResult?(text: string): Promise<GuardrailStep<{ text: string }>>;
}

/**
 * An agent's memory (round 5 §2.2). With `enabled`, the prompt carries the memory-operations block,
 * and the `__memory` field is taken out of the JSON answer before the output point; the valid ops are
 * applied once the answer has been accepted.
 */
export interface NodeMemoryHook {
  enabled: boolean;
  apply(ops: MemoryOp[]): Promise<void>;
}

/**
 * What a guardrail point decided about what was flowing through (FR-GRD-007, FR-GRD-011..015).
 *
 * `continue` carries the content on — possibly rewritten, which is how a `redact` reaches the prompt
 * and the stored output (FR-GRD-014). `failed` names the reason the node run records, so a guardrail
 * block stays `GUARDRAIL_VIOLATION` and a contract failure stays `CONTRACT_VIOLATION` (D9, D85).
 */
export type GuardrailStep<T> =
  | ({ kind: 'continue'; verdicts?: Verdict[] } & T)
  | { kind: 'failed'; failureReason: FailureReason; error: NodeError; verdicts?: Verdict[] };

/**
 * The guardrail points the executor runs, supplied per node run by the scheduler (Arch §13.1).
 *
 * The executor calls them and does nothing else about guardrails: it does not resolve a policy, does
 * not store a verdict and does not know what `ask_user` means. That matters at the output point in
 * particular — the hook runs *before* `node.output` is emitted, so a masked secret is masked
 * everywhere, including on the socket (BR-07, D86).
 */
export interface NodeGuardrails {
  /**
   * The input point: every envelope's reads, before prompt assembly (FR-GRD-003). Optional, so a
   * build that wires only the tool point (round 4) still satisfies this interface; absent, the input
   * is not checked.
   */
  beforePrompt?(envelopes: readonly Envelope[]): Promise<GuardrailStep<{ envelopes: Envelope[] }>>;
  /**
   * The output point, before the contract decides (FR-GRD-007, §4 item 4). When this is wired it
   * **owns** the contract check too, so an output is validated exactly once (D85). Optional: absent,
   * the executor validates the contract itself, the round-2 behaviour.
   */
  afterOutput?(
    parts: Part[],
    contract?: EnvelopeContract,
  ): Promise<GuardrailStep<{ parts: Part[] }>>;
  /**
   * The policy's tool-call cap (round 4 §2.2). The loop's limit is `min` of this and the agent's own
   * `tools.maxToolCalls`; absent means the policy sets no cap and the agent's own limit stands.
   */
  maxToolCalls?: number;
  /**
   * The tool point (round 4 §2.2, FR-GRD-005/006). Runs `checkToolArgs` and the four policy checks
   * (`tool_allowed`, `path_confinement`, `domain_allowlist`, `destructive_action`), applies each
   * action — a `block` fails the call, a destructive tool's `ask_user` waits for the Round 3 approval
   * card and a reject fails the call — and records the verdicts. Absent means no guardrail engine is
   * wired, so the executor runs the tool unchecked (the round-2 posture for the other points).
   */
  beforeTool?(input: ToolPointInput): Promise<ToolGuardStep>;
}

export interface NodeExecutionOutcome {
  /**
   * `NodeState` rather than the two round-2 values: a cancelled node ends `STOPPED`, not `FAILED`
   * (FR-ERR-007), and an upstream that never produced anything leaves this one `BLOCKED`
   * (FR-ERR-006). The state is `nodeStateFor(error)`, which is the one table for it (Arch §19.1).
   */
  status: NodeState;
  output: Part[];
  usage: Usage;
  failureReason?: FailureReason;
  error?: NodeError;
  modelUsed?: ModelUsed;
  prompt?: { version: string; text: string };
  /** Every verdict the points above recorded, in the order they were recorded (FR-GRD-015). */
  verdicts?: Verdict[];
  /** Round 5: the chunks the node's context used, best first (FR-RAG-007). */
  sources?: NodeRunSource[];
  /** Round 5: chunks the search found that did not fit the context budget. */
  droppedSources?: NodeRunSource[];
  /** Round 5: the `__memory` ops this node run applied, in order (FR-MEM-002). */
  memoryOps?: MemoryOp[];
  /**
   * Round 5: the envelopes this node run read, with what it read placed on them — a Retrieval
   * node's hits as `context.retrieved` (R5 §2.4, FR-RAG-007) — stored on its row in place of the
   * delivered ones. Absent, the row keeps the envelopes it was delivered.
   */
  inputEnvelopes?: Envelope[];
  /**
   * D309: what a turn a human message cut short had already written. Kept on its row and in the
   * log (`node.interrupted`), never handed off.
   */
  partialOutput?: Part[];
  /**
   * D310: the envelopes the answer's blocks asked for, judged, their summaries through the output
   * point and secret-masked. Absent when the node was given no rules; empty when it wrote none.
   */
  teamEnvelopes?: JudgedEnvelope[];
}

export interface NodeExecutorDeps {
  bus: EventBus;
  logger: Logger;
  adapterFor: (providerId: Id) => Promise<ProviderAdapter>;
  /** The catalog rows the router chooses from and the executor prices against. */
  modelsFor: () => Promise<Model[]>;
  /**
   * PG-1.4 (D359): the provider row a call went to, for the cost rule — a local model is $0 by
   * rule and an unpriced remote one is `costKnown: false`. Absent, the price table alone decides.
   */
  providerFor?: (providerId: Id) => Promise<PricedProvider | undefined>;
  /** Runs the provider call inside that provider's concurrency gate (FR-PRV-009). */
  runGated: <T>(providerId: Id, fn: () => Promise<T>) => Promise<T>;
  /**
   * Required, and never built here: the router lives in `@ace/providers` and the engine may not
   * import it (CLAUDE.md §3.4 rule 3). A second implementation inside the engine would be a
   * second set of routing rules to keep in step, which is exactly what FR-RTR-002 cannot afford.
   */
  router: ModelRouter;
  now?: () => string;
  tokenBatchMs?: number;

  /* ------------------------------------------------------------- round 4 */
  /*
   * The tool loop and multimodal materialisation (round 4 §2.2, §2.6, Arch §12.7, FR-TOOL-*,
   * FR-MM-003/004). All optional, exactly as the round-3 services are: a harness that only exercises
   * text agents builds an executor without them, and then a `tool_call` chunk from a scripted adapter
   * fails the node rather than crashing (a model that asked for a tool the engine cannot run). The
   * gateway (Wave 3) binds these to `@ace/tools`, the artifact store and the tool-call repository.
   */

  /** The registry a requested tool is looked up in — built-ins plus connected MCP servers. */
  tools?: ToolProvider;
  /** `<projectFolder>/.ace/sandbox/<runId>/` for one run — the folder a tool is confined to. */
  sandboxDirFor?: (runId: Id) => string;
  /** Resolves Input `artifactIds` to parts and stores produced media parts as artifacts. */
  artifacts?: ArtifactMaterialiser;
  /**
   * Persists one logged `ToolCall` (FR-TOOL-009), mirroring it onto its node run's `toolCalls` list
   * — the same one-write-path the verdict and approval stores use. The executor also emits the
   * `tool.call` event itself, so a harness without this still sees the frame.
   */
  recordToolCall?: (runId: Id, call: ToolCall) => Promise<void>;
  /** ToolCall ids. Defaults to the shared id generator. */
  nextId?: () => string;

  /* ------------------------------------------------------------- round 5 */

  /**
   * The knowledge-base search a Retrieval node runs (§2.4, FR-RAG-006). Optional like the round 4
   * services: without it a Retrieval node is BLOCKED (`knowledge_unavailable`) rather than crashing.
   */
  search?: SearchService;

  /* ------------------------------------------------------------------ X1 */

  /**
   * The project folder a run works in (X1 §4.2): handed to the provider as `workingDir` (an
   * agent-route CLI runs there) and to the project tools as `projectDir`. Absent, or failing, the
   * provider gets no folder and the project tools refuse.
   */
  projectFolderFor?: (runId: Id) => Promise<string | undefined>;

  /* ------------------------------------------------------- agentic nodes */

  /**
   * D375: the computer an agentic node works on, for its rules — the OS, and the shell
   * `run_command` runs in as `@ace/tools` resolves it (the engine may not import that package,
   * CLAUDE.md §3.4 rule 3). Absent, the OS is this process's and the shell is named generically.
   */
  agentEnvironment?: { os: NodeJS.Platform; shell: string };
  /**
   * D375/D376 (Task 16 follow-up): the live run's command allowlist, so a CLI-backed agentic node
   * is given the prefixes Always allow has grown, not only the snapshot's. Absent, or once the
   * run has ended, the node's own `workspace.allowedCommands` apply.
   */
  allowlistFor?: (runId: Id) => { for(nodeId: Id): readonly string[] } | undefined;
}

export interface NodeExecutor {
  execute(input: ExecuteNodeInput): Promise<NodeExecutionOutcome>;
}

const NO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

/** Everything an executing node can read: the reads of every envelope delivered to it. */
function readsOf(envelopes: readonly Envelope[]): Part[] {
  return [...envelopes]
    .sort((a, b) => a.fromNodeId.localeCompare(b.fromNodeId))
    .flatMap((envelope) => envelope.reads);
}

/** How long a tool ran, from two ISO timestamps. Never negative; 0 when the clock is fixed (tests). */
/**
 * A provider-side action as a ToolCall name (X1 §4.3): `cli_` and the tool in snake_case, so it
 * satisfies `TOOL_NAME_REGEX` and never collides with an ACE tool — `Bash` → `cli_bash`.
 */
export function activityToolName(tool: string): string {
  const snake = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `cli_${snake === '' ? 'action' : snake}`;
}

function durationSince(startedAt: string): number {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Date.now() - started);
}

/**
 * Whether a thrown tool error is a timeout rather than any other failure (round 4 §2.2, TC-TOOL-004).
 * The engine may not import `@ace/tools`, so it duck-types: a `TimeoutError`, a `timeout` kind/code, or
 * a message that says as much. Anything else is a plain tool `error`.
 */
function isToolTimeout(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  const bag = error as { kind?: unknown; code?: unknown };
  if (bag?.kind === 'timeout' || bag?.code === 'timeout') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timed out|timeout/i.test(message);
}

/** A tool the model asked for in one turn (one per turn, Arch §12.7). */
interface PendingToolCall {
  callId: string;
  name: string;
  args: unknown;
}

/** One model turn: the tools it asked for, or a stop that caught it while it queued for its slot. */
type TurnOutcome = { kind: 'cancelled' } | { kind: 'called'; pendingCalls: PendingToolCall[] };

/**
 * A coding-agent CLI's one "turn" is its whole session — reading, editing, running tests — so it
 * gets at least the longest node timeout the contract allows rather than the 2-minute default sized
 * for one model reply (review I6). Stop still ends it at once.
 */
export const CLI_SESSION_MIN_TIMEOUT_MS = 600_000;

/**
 * An accepted, paid-for answer whose memory ops the store refused (13a review m1): Arch §28's
 * `workflow` kind, like any failure of the engine's own store, and not retryable — a retry would pay
 * for the call again. The store's error is in the engine log, never on the row, because it may
 * describe the values it was handed.
 */
function memoryNotSavedError(): NodeError {
  return {
    kind: 'workflow',
    code: 'memory_not_saved',
    message:
      'The answer was accepted, but its memory operations could not be saved, so this node run failed. The engine log has the details.',
    retryable: false,
  };
}

/**
 * What a node the run's abort caught inside a guardrail point records: a cancellation, never a
 * failure (FR-ERR-007, D-054). An `ask_user` wait throws its own `user_cancelled` when the run is
 * stopped or shut down; anything else thrown once the run is aborted ends the node the same way,
 * because the Stop has already ended it STOPPED (D111).
 */
function stoppedError(error: unknown, message: string): NodeError {
  const classified = error === undefined ? undefined : classifyError(error);
  return classified?.kind === 'user_cancelled' ? classified : userCancelledError(message).nodeError;
}

/*
 * There is no private classifier here any more: `classifyError` is the one in `../errors/` and the
 * eight kinds of Arch §28 are decided in exactly one place (FR-ERR-001). Two deliberate changes come
 * with it (D109): a `TimeoutError` is `network` and retryable rather than a cancellation — Arch §28
 * groups timeouts with network failures, and `AbortSignal.timeout()` is what raises it — while a bare
 * `AbortError` stays `user_cancelled`; and an HTTP status carried on the thrown error decides.
 */

export function createNodeExecutor(deps: NodeExecutorDeps): NodeExecutor {
  const batchMs = deps.tokenBatchMs ?? TOKEN_BATCH_MS;
  const nextId = deps.nextId ?? newId;

  /**
   * A failure, shaped the way the node run row wants it, and announced.
   *
   * D-063: once the run is aborted, whatever went wrong is not this node's failure to announce. The
   * Stop (or the shutdown) decides how it ends — STOPPED, with a cancellation and what it spent —
   * so no `node.error` goes out, where it could follow the run's `run.completed` (D111, FR-ERR-007).
   */
  async function fail(
    input: ExecuteNodeInput,
    failure: NodeError,
    usage: Usage = NO_USAGE,
    extra: Partial<NodeExecutionOutcome> = {},
  ): Promise<NodeExecutionOutcome> {
    const aborted = input.signal.aborted;
    const error =
      aborted && failure.kind !== 'user_cancelled'
        ? userCancelledError('The run was stopped before this node run could finish.').nodeError
        : failure;
    const { status: extraStatus, failureReason: extraReason, ...rest } = extra;
    const status = aborted ? 'STOPPED' : (extraStatus ?? nodeStateFor(error));
    // FR-ERR-007: a node the user stopped has not failed, so it records no failure reason. Writing
    // `RUN_FAILED` beside `STOPPED` is exactly the conflation BR-03 forbids.
    const failureReason =
      status === 'STOPPED' ? undefined : (extraReason ?? failureReasonFor(error));

    // A cancellation is not an error frame. `node.error` carries a required `failureReason` and the
    // UI paints one red; a node the user stopped has neither (FR-ERR-007). Its `node.state` frame
    // says `STOPPED`, and the node run still records the `user_cancelled` error behind it.
    if (failureReason !== undefined) {
      await deps.bus.emit({
        type: 'node.error',
        workflowId: input.workflowId,
        runId: input.runId,
        payload: {
          runId: input.runId,
          nodeRunId: input.nodeRunId,
          nodeId: input.node.id,
          error,
          failureReason,
        },
      });
    }

    return {
      output: [],
      usage,
      error,
      ...(failureReason === undefined ? {} : { failureReason }),
      ...rest,
      status,
    };
  }

  async function succeed(
    input: ExecuteNodeInput,
    output: Part[],
    usage: Usage,
    extra: Partial<NodeExecutionOutcome> = {},
  ): Promise<NodeExecutionOutcome> {
    // D-063: a result that arrives once the run is aborted is not announced — no `node.output` for
    // a node the Stop has ended, and none after `run.completed`. It ends STOPPED, keeping what it
    // spent (D111, FR-ERR-007).
    if (input.signal.aborted) {
      return fail(
        input,
        userCancelledError("The run was stopped before this node's result was recorded.").nodeError,
        usage,
        extra,
      );
    }

    await deps.bus.emit({
      type: 'node.output',
      workflowId: input.workflowId,
      runId: input.runId,
      payload: {
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        nodeId: input.node.id,
        output,
        usage,
        ...(extra.modelUsed === undefined ? {} : { modelUsed: extra.modelUsed }),
      },
    });

    return { status: 'COMPLETED', output, usage, ...extra };
  }

  /* ---------------------------------------------------------------- agents */

  /**
   * An agent or Model node run. The chunks its context hook placed and dropped go on whatever the
   * run ends as — a contract violation still read those chunks (FR-RAG-007) — and only when there
   * were any, so a node with no knowledge base records exactly the round 4 shape.
   */
  async function executeAgent(input: ExecuteNodeInput): Promise<NodeExecutionOutcome> {
    const used: Pick<NodeExecutionOutcome, 'sources' | 'droppedSources'> = {};
    const outcome = await callAgent(input, used);
    return { ...outcome, ...used };
  }

  /**
   * D375: an Agent node with workspace access works in the project folder in a multi-turn tool
   * loop. `undefined` keeps today's path: an Off node, a replay (it calls nothing), and a node on a
   * coding-agent CLI — **the CLI branch**: a CLI runs its own tools, so it keeps today's single
   * call, and its per-node access (`GenerateRequest.cliAccess`, Task 16) is wired where this returns
   * for it. A node with no project folder to work in fails here, before any call.
   */
  async function agenticSetup(
    input: ExecuteNodeInput,
  ): Promise<undefined | { failed: NodeError } | { state: AgentLoopState; workspaceRoot: string }> {
    const node = input.node;
    if (node.kind !== 'agent' || !isAgentic(node.config) || input.replay !== undefined) {
      return undefined;
    }
    const providerId = node.config.providerId;
    if (providerId !== undefined) {
      let provider: PricedProvider | undefined;
      try {
        provider = await deps.providerFor?.(providerId);
      } catch {
        provider = undefined;
      }
      // The CLI branch (see above): today's single call.
      if (provider !== undefined && isCliProviderType(provider.type)) return undefined;
    }
    let root: string | undefined;
    try {
      root = await deps.projectFolderFor?.(input.runId);
    } catch {
      root = undefined;
    }
    if (root === undefined || root === '') {
      return {
        failed: {
          kind: 'invalid_config',
          code: 'project_folder_missing',
          message: `Give the project a folder to let ${node.name} work in it.`,
          retryable: false,
        },
      };
    }
    return { state: newAgentLoopState(agentWorkspaceOf(node.config)), workspaceRoot: root };
  }

  async function callAgent(
    input: ExecuteNodeInput,
    used: Pick<NodeExecutionOutcome, 'sources' | 'droppedSources'>,
  ): Promise<NodeExecutionOutcome> {
    const node = input.node;
    if (node.kind !== 'agent' && node.kind !== 'model') {
      throw new Error(`executeAgent called for a ${node.kind} node`);
    }
    // Once per node run: a fallback to a second provider waits at that gate too, but the node has
    // already started (D66).
    let starting: Promise<void> | undefined;
    const started = (): Promise<void> => (starting ??= input.onStarted?.() ?? Promise.resolve());

    const instructions =
      node.kind === 'agent' ? node.config.instructions : (node.config.systemPrompt ?? '');
    /*
     * D353 (PG-2.1): a JSON schema implies JSON output, so an Agent left at `['text']` with a schema
     * is parsed and checked like a `json` one. Every read of the node's output types below goes
     * through this list.
     */
    const effectiveTypes = effectiveOutputTypes(node.config);
    const contract: EnvelopeContract = {
      outputTypes: effectiveTypes,
      ...(node.kind === 'agent' && node.config.outputContract?.jsonSchema !== undefined
        ? { jsonSchema: node.config.outputContract.jsonSchema }
        : {}),
      ...(node.config.execution.maxTokens === undefined
        ? {}
        : { maxTokens: node.config.execution.maxTokens }),
    };

    /* The collected verdicts of both points, carried on the outcome for the report (FR-GRD-015). */
    const verdicts: Verdict[] = [];
    /*
     * Round 5 (§2.2): the memory-operations block, and `__memory` read out of the answer. Only for a
     * JSON answer (13a review m2): `__memory` is a field of the JSON output, and only the JSON branch
     * below reads it, so a text-only agent is never told to write one nothing would apply.
     */
    const memoryOn = input.memory?.enabled === true && effectiveTypes.includes('json');
    /*
     * The schema the provider is held to. With memory on it also allows an optional `__memory` list,
     * or a provider that enforces schemas could never emit one; the answer is still validated against
     * the agent's own schema, once `__memory` is out of it.
     */
    const providerSchema =
      memoryOn && contract.jsonSchema !== undefined
        ? withMemoryField(contract.jsonSchema)
        : contract.jsonSchema;

    let envelopes = input.envelopes;

    /*
     * The context, before the input point (round 5 §2.2–§2.4, FR-GRD-004): retrieved chunks and
     * memory placed on the first envelope, and every untrusted piece through the context guardrails.
     * It runs first so the input point and the prompt both see exactly what was placed.
     */
    if (input.context !== undefined) {
      const built = await input.context.build(envelopes, input.signal);
      verdicts.push(...(built.verdicts ?? []));
      if (built.kind === 'failed') {
        return fail(input, built.error, NO_USAGE, {
          failureReason: built.failureReason,
          verdicts,
        });
      }
      // Stopped as the context was built (13a review m3): nothing is checked, assembled or called.
      if (input.signal.aborted) {
        return fail(
          input,
          userCancelledError('The run was stopped while this node read its context.').nodeError,
          NO_USAGE,
          { verdicts },
        );
      }
      envelopes = built.envelopes;
      if (built.sources.length > 0) used.sources = built.sources;
      if (built.droppedSources.length > 0) used.droppedSources = built.droppedSources;
    }

    /*
     * The input point, before assembly (FR-GRD-003, §4 item 4). It runs here rather than in the
     * scheduler for one reason: a `redact` has to reach the prompt, and the prompt is built on the
     * next line.
     */
    if (input.guardrails?.beforePrompt !== undefined) {
      const checked = await input.guardrails.beforePrompt(envelopes);
      verdicts.push(...(checked.verdicts ?? []));
      if (checked.kind === 'failed') {
        return fail(input, checked.error, NO_USAGE, {
          failureReason: checked.failureReason,
          verdicts,
        });
      }
      envelopes = checked.envelopes;
    }

    /* D375: an agentic node's loop state, or `undefined` for today's path. */
    const setup = await agenticSetup(input);
    if (setup !== undefined && 'failed' in setup) {
      return fail(input, setup.failed, NO_USAGE, { verdicts });
    }
    const agent = setup;

    // FR-ERR-005 / §2.1: the one contract-repair retry is the same prompt with the validation
    // reason appended, so the model is told what was wrong with its last answer.
    const ownInstructions =
      input.repairReason === undefined
        ? instructions
        : `${instructions}\n\nYour previous answer was rejected: ${input.repairReason}\nAnswer again, satisfying the output contract exactly.`;
    const prompt = assemblePrompt({
      // D375: an agentic node's instructions carry the rules of working in the project folder.
      instructions:
        agent === undefined
          ? ownInstructions
          : agentSystemPrompt({
              instructions: ownInstructions,
              workspaceRoot: agent.workspaceRoot,
              os: deps.agentEnvironment?.os ?? process.platform,
              shell: deps.agentEnvironment?.shell ?? 'the system shell',
              access: agent.state.workspace.access,
              upstream: envelopes.flatMap((envelope) =>
                envelope.workspace === undefined ? [] : [envelope.workspace],
              ),
            }),
      envelopes,
      contract,
      iteration: input.iteration,
      ...(memoryOn ? { memoryInstructions: true } : {}),
      ...(input.team === undefined ? {} : { team: input.team }),
    });

    /* Route. The router is pure over the catalog and never calls a provider (FR-RTR-006). */
    const catalog = await deps.modelsFor();
    const routing =
      node.kind === 'agent'
        ? node.config.routing
        : { policy: 'fixed' as const, fallbackModelIds: [] };

    // The `agent | model` narrowing above does not reach inside `attemptWith`, so the fields it
    // needs are captured here rather than re-narrowed there.
    const outputTypes = effectiveTypes;
    const { temperature } = node.config.execution;

    /*
     * The tool set (round 4 §2.2). Only an agent node has tools; a bare model node never calls one.
     * The limit is `min(agent's own maxToolCalls, the policy's max_tool_calls)` — the policy's cap
     * arrives on the guardrail hook (`maxToolCalls`), and absent it the agent's own stands.
     */
    // D375: an agentic node is offered its access level's tools (plus its other enabled ones), and
    // only the policy's `max_tool_calls` caps it — its Max turns and token budget bound it.
    const enabledTools =
      node.kind !== 'agent'
        ? []
        : agent === undefined
          ? node.config.tools.enabled
          : agentToolNames(node.config);
    const allowedDomains = node.kind === 'agent' ? node.config.tools.allowedDomains : [];
    const agentMaxToolCalls =
      node.kind !== 'agent'
        ? 0
        : agent === undefined
          ? node.config.tools.maxToolCalls
          : Number.POSITIVE_INFINITY;
    const policyMaxToolCalls = input.guardrails?.maxToolCalls;
    const toolCallLimit = Math.min(
      agentMaxToolCalls,
      policyMaxToolCalls ?? Number.POSITIVE_INFINITY,
    );
    /** The enabled tools' definitions, offered to the model each turn (FR-TOOL-003). */
    const offeredTools: ToolDefinition[] = enabledTools.flatMap((name) => {
      const registered = deps.tools?.get(name);
      return registered === undefined ? [] : [registered.definition];
    });

    const routingNode = {
      ...(node.config.providerId === undefined ? {} : { providerId: node.config.providerId }),
      ...(node.config.modelId === undefined ? {} : { modelId: node.config.modelId }),
      routing,
    };
    const requirements = {
      inputTypes: node.config.inputTypes,
      outputTypes: node.config.outputTypes,
    };

    /**
     * The fallback chain (FR-RTR-002, TC-RTR-002). The router decides *which* model is next; this
     * loop is what asks it again after a failure a different model could survive. Only
     * `provider` and `network` failures come back here — the router itself refuses to move on
     * from anything else, and this stops immediately so the chain is never walked pointlessly.
     *
     * Retry of the *same* model with backoff is round 3; this is moving to the next one.
     */
    const failures: { modelId: string; kind: NodeError['kind'] }[] = [];
    let lastProviderError: NodeError | undefined;
    let lastUsage: Usage = NO_USAGE;
    let lastModelUsed: ModelUsed | undefined;
    const promptRecord = { version: prompt.version, text: prompt.redactedText };

    // One attempt per model in the chain, plus one: the router stops before this ever binds.
    const maxAttempts = 2 + routing.fallbackModelIds.length;
    const replayed = input.replay?.kind === 'recorded' ? input.replay : undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // PG-5.4: a replay takes the model the source run used, once — no routing, no fallback.
      const route: RouteResult =
        replayed !== undefined
          ? attempt === 0
            ? { ok: true, route: replayed.route }
            : { ok: false, code: 'no_candidate_left', reason: 'A replay answers each call once.' }
          : deps.router.resolve(routingNode, requirements, {
              failures,
            });

      if (!route.ok) {
        // TC-RTR-003: when the chain is exhausted the useful answer is what actually went wrong,
        // not "the router ran out of options".
        return lastProviderError === undefined
          ? fail(
              input,
              {
                kind: 'invalid_config',
                code: route.code,
                message: route.reason,
                retryable: false,
              },
              NO_USAGE,
              { verdicts: [...verdicts] },
            )
          : fail(input, lastProviderError, lastUsage, {
              ...(lastModelUsed === undefined ? {} : { modelUsed: lastModelUsed }),
              prompt: promptRecord,
              verdicts: [...verdicts],
            });
      }

      const outcome = await attemptWith(route.route);
      if (outcome.kind === 'done') return outcome.result;

      failures.push({ modelId: route.route.modelId, kind: outcome.error.kind });
      lastProviderError = outcome.error;
      lastUsage = outcome.usage;
      lastModelUsed = route.route;
    }

    /* Unreachable in practice: the router refuses before the attempt budget runs out. */
    return fail(
      input,
      lastProviderError ?? {
        kind: 'provider',
        code: 'no_candidate_left',
        message: 'Every model in the routing chain was tried.',
        retryable: false,
      },
      lastUsage,
      { prompt: promptRecord },
    );

    /** One call against one resolved model. */
    async function attemptWith(
      chosen: ModelUsed,
    ): Promise<
      | { kind: 'done'; result: NodeExecutionOutcome }
      | { kind: 'retryable'; error: NodeError; usage: Usage }
    > {
      const catalogRow = catalog.find(
        (model) => model.providerId === chosen.providerId && model.modelId === chosen.modelId,
      );
      const pricing = catalogRow?.pricing;
      let pricedProvider: PricedProvider | undefined;
      try {
        pricedProvider = await deps.providerFor?.(chosen.providerId);
      } catch {
        pricedProvider = undefined;
      }
      const modelTakesTools = catalogRow?.supportsTools !== false;

      /*
       * D375: an agentic node never runs text-only on a model that cannot call tools — pre-flight
       * refuses that for the node's own model, and a fallback to one ends here, before any call.
       */
      if (agent !== undefined && !modelTakesTools) {
        return {
          kind: 'done',
          result: await fail(
            input,
            {
              kind: 'invalid_config',
              code: 'model_cannot_use_tools',
              message: `${catalogRow?.displayName ?? chosen.modelId} can't use tools. Pick another model, or turn tools on for it in Providers.`,
              retryable: false,
            },
            NO_USAGE,
            { verdicts: [...verdicts] },
          ),
        };
      }
      // D377: a fallback to another model drops the opaque records the history holds, so one
      // model's thought signatures are never replayed to another.
      if (agent !== undefined) {
        const modelKey = `${chosen.providerId}/${chosen.modelId}`;
        if (agent.state.modelKey !== undefined && agent.state.modelKey !== modelKey) {
          agent.state.history = withoutOpaque(agent.state.history);
        }
        agent.state.modelKey = modelKey;
      }

      // A copy: a `model` chunk adds what the provider says actually answered, and the router's
      // route object is not this attempt's to change.
      const modelUsed: ModelUsed = { ...chosen };

      /* Call, inside this provider's concurrency gate. */
      let text = '';
      let jsonValue: unknown;
      let sawJson = false;
      /**
       * Media/typed parts a model emitted directly (round 4 §2.6 `mock-media`, FR-MM-003), each with
       * the bytes behind it when the provider generated them — held only until the materialiser
       * stores them; they never reach an envelope or an event (FR-MM-004).
       */
      const partChunks: ProducedPart[] = [];
      let tokensIn = 0;
      let tokensOut = 0;
      let finishReason: string = 'stop';
      /** The valid `__memory` ops this attempt's answer carried (round 5 §2.2). */
      let memoryOps: MemoryOp[] = [];

      const tokens = createBatcher<string>({
        intervalMs: batchMs,
        flush: (deltas) => {
          void deps.bus.emitTransient({
            type: 'node.token',
            workflowId: input.workflowId,
            runId: input.runId,
            payload: {
              runId: input.runId,
              nodeRunId: input.nodeRunId,
              delta: deltas.join(''),
            },
          });
        },
      });

      /**
       * Stopped while it waited for its slot (FR-CTL-003, D111): the stop has already ended this
       * node run STOPPED, so nothing is called — the model would only be handed a dead signal.
       */
      let cancelled = false;

      /* The run's sandbox folder, the only place a tool may touch (round 4 §2.2, NFR-SEC-03). */
      const sandboxDir = deps.sandboxDirFor?.(input.runId) ?? '';
      /* X1 §4.2: the project folder, for an agent-route provider and the project tools. */
      let workingDir: string | undefined;
      try {
        const folder = await deps.projectFolderFor?.(input.runId);
        workingDir = folder === undefined || folder === '' ? undefined : folder;
      } catch {
        workingDir = undefined;
      }
      /** What the provider said the call cost (D263), when it says; otherwise the price table. */
      let reportedCostUsd: number | undefined;
      /** D313: whether the provider reported usage at all, and how much input it read from cache. */
      let sawUsage = false;
      let cachedTokensIn = 0;
      const usageNow = (): Usage => {
        const priced = usageFor(tokensIn, tokensOut, pricing, pricedProvider);
        return {
          ...(reportedCostUsd === undefined ? priced : withReportedCost(priced, reportedCostUsd)),
          ...(cachedTokensIn > 0 ? { cachedTokensIn } : {}),
        };
      };
      /** Untrusted tool-result blocks appended to the *recorded* prompt (FR-TOOL-010, FR-PRM-002). */
      const promptSuffix: string[] = [];
      /** A tool-point block or an approval reject that ends this node GUARDRAIL_VIOLATION (§2.2). */
      let toolFailure: { error: NodeError; failureReason: FailureReason } | undefined;
      /** The model still asked for a tool after the limit forced a no-tool turn (FR-TOOL-003). */
      let toolLimitExceeded = false;
      let toolCallCount = 0;
      /** D375: the agentic node reached its Max turns or its token budget. */
      let agentLimit: NodeError | undefined;
      /** D377: what the latest model turn said, and the provider's own record of it. */
      let turnText = '';
      let turnOpaque: AgentTurn['opaque'];

      /** The recorded prompt for this attempt, with any untrusted tool-result blocks appended. */
      const recordedPrompt = (): { version: string; text: string } => ({
        version: prompt.version,
        text:
          promptSuffix.length === 0
            ? prompt.redactedText
            : `${prompt.redactedText}\n\n## Tool results\n${promptSuffix.join('\n\n')}`,
      });

      /** Whether this attempt made a provider call, so a stop records what it spent (FR-ERR-007). */
      let called = false;
      /** Resolved by the first turn, once the slot is held. */
      let adapter: ProviderAdapter | undefined;

      try {
        /*
         * The agentic tool loop (Arch §12.7): generate, and while the model asks for a tool, run it
         * under the tool-point guardrails and feed the result back as untrusted, until a final answer
         * or the call limit (round 4 §2.2, FR-TOOL-003).
         *
         * Each model turn holds this provider's concurrency slot, and only the turn (D-062): the
         * tool-point guardrails — a destructive call's approval above all, which waits on a person —
         * and the tool itself run with the slot given back. FR-PRV-009 limits provider *calls*, and a
         * node WAITING on a card must not keep every other node on its provider READY behind it
         * (R3 §4 item 4, D66).
         */
        const toolResults: ToolResult[] = [];
        /** After the call limit, the model is asked once more with no tools (§2.2, FR-TOOL-003). */
        let finalTurn = false;

        if (agent !== undefined) {
          // D375: an agentic node's loop — turn history, elision, Max turns and token budget.
          await runAgentTurns(agent.state);
        } else {
          for (;;) {
            const turn = await takeTurn(toolResults.length > 0, finalTurn);
            if (turn.kind === 'cancelled') {
              cancelled = true;
              break;
            }

            const pendingCalls = turn.pendingCalls;
            // No tool requested: the turn's text/json/parts are this node's answer (FR-TOOL-003).
            if (pendingCalls.length === 0) break;

            // A tool after the model was asked to finish without tools ends the node (FR-TOOL-003).
            if (finalTurn) {
              toolLimitExceeded = true;
              break;
            }

            // Every call of the turn, in order — models ask for several at once (review I2). Each is
            // guarded and counted on its own; the adapter replays them one call, one result at a time.
            for (const pendingCall of pendingCalls) {
              const handled = await runToolCall(pendingCall, input.signal);
              if (handled.failed !== undefined) {
                toolFailure = handled.failed;
                break;
              }

              toolResults.push({
                callId: pendingCall.callId,
                name: pendingCall.name,
                args: pendingCall.args,
                result: handled.result,
              });
              // The result reaches the *recorded* prompt inside an untrusted block (FR-PRM-002); the
              // adapter itself reads `toolResults` (FR-TOOL-010).
              promptSuffix.push(toolResultBlock(pendingCall.name, handled.result));
              toolCallCount += 1;

              // Reaching the limit ends the loop; the model is asked once more with no tools (§2.2).
              // The turn's later calls are not run, and are not replayed.
              if (toolCallCount >= toolCallLimit) {
                finalTurn = true;
                break;
              }
            }
            if (toolFailure !== undefined) break;
          }
        }

        /**
         * D375/D377: the agentic loop. Before every model call the node's limits are checked and its
         * history trimmed to fit; each turn is one `node.turn`; every call of a turn is answered —
         * run, denied, cancelled by a Stop or skipped past the policy's limit — before the next call,
         * so no provider is ever sent a call without its result.
         */
        async function runAgentTurns(state: AgentLoopState): Promise<void> {
          // Carried across a fallback: a node already at the policy's cap is asked without tools.
          let withoutTools = state.toolCalls >= toolCallLimit;
          const budget = {
            contextWindow: catalogRow?.contextWindow ?? AGENT_DEFAULT_CONTEXT_WINDOW,
            fixedChars:
              prompt.text.length + prompt.system.length + JSON.stringify(offeredTools).length,
          };

          for (;;) {
            agentLimit = checkLimits(state, state.workspace);
            if (agentLimit !== undefined) return;
            state.history = elideTurns(state.history, budget);

            const inBefore = tokensIn;
            const outBefore = tokensOut;
            const turn = await takeTurn(state.turns > 0, withoutTools);
            if (turn.kind === 'cancelled') {
              cancelled = true;
              return;
            }
            state.turns += 1;
            const turnIn = Math.max(0, tokensIn - inBefore);
            const turnOut = Math.max(0, tokensOut - outBefore);
            // A provider that reports no usage is estimated for the budget, characters ÷ 4 (D313).
            const reported = turnIn + turnOut > 0;
            state.tokensIn += reported ? turnIn : estimateTokens(prompt.text);
            state.tokensOut += reported ? turnOut : estimateTokens(turnText);

            const calls = turn.pendingCalls;
            if (!input.signal.aborted) {
              await deps.bus.emit({
                type: 'node.turn',
                workflowId: input.workflowId,
                runId: input.runId,
                payload: {
                  runId: input.runId,
                  nodeRunId: input.nodeRunId,
                  nodeId: input.node.id,
                  turn: state.turns,
                  tokensIn: turnIn,
                  tokensOut: turnOut,
                  toolCalls: calls.length,
                },
              });
            }
            // No tool requested: this turn's words are the node's answer (FR-TOOL-003).
            if (calls.length === 0) return;
            // A tool after the model was asked to finish without tools ends the node (FR-TOOL-003).
            if (withoutTools) {
              toolLimitExceeded = true;
              return;
            }

            const results: ToolResult[] = [];
            for (let index = 0; index < calls.length; index += 1) {
              const call = calls[index]!;
              // Past the policy's limit: answered, not run; the model is asked once more without
              // tools (round 4 §2.2).
              if (withoutTools) {
                results.push({ ...call, result: skippedCallResult(toolCallLimit) });
                continue;
              }
              // A Stop mid-batch: no further call runs and none is sent; the rest are logged.
              if (input.signal.aborted) {
                await logCancelled(calls.slice(index));
                throw userCancelledError('The run was stopped before this tool call ran.');
              }
              let handled: Awaited<ReturnType<typeof runToolCall>>;
              try {
                handled = await runToolCall(call, input.signal);
              } catch (error) {
                if (input.signal.aborted) await logCancelled(calls.slice(index));
                throw error;
              }
              if (handled.failed !== undefined) {
                toolFailure = handled.failed;
                return;
              }
              results.push({ ...call, result: handled.result });
              // The recorded prompt keeps each result's summary, so a long loop's row stays
              // bounded; the model reads the whole result through `turns` (FR-TOOL-010).
              promptSuffix.push(toolResultBlock(call.name, summariseResult(handled.result)));
              state.toolCalls += 1;
              toolCallCount = state.toolCalls;
              if (state.toolCalls >= toolCallLimit) withoutTools = true;
            }

            state.history.push({
              text: turnText,
              toolCalls: calls.map(({ callId, name, args }) => ({ callId, name, args })),
              results,
              ...(turnOpaque === undefined ? {} : { opaque: turnOpaque }),
            });
          }
        }

        /** D375: the calls a Stop caught before they ran, logged the way a failed call is. */
        async function logCancelled(calls: readonly PendingToolCall[]): Promise<void> {
          const at = deps.now?.() ?? new Date().toISOString();
          for (const call of calls) {
            await logToolCall(call, {
              status: 'error',
              resultSummary: CANCELLED_SUMMARY,
              durationMs: 0,
              verdicts: [],
              at,
              callId: call.callId,
            });
          }
        }

        /**
         * Queue for this provider's slot and make one model turn inside it (D66, FR-PRV-009).
         *
         * A stop while queued ends the node without a call (FR-CTL-003, D111). A pause holds a turn
         * that has to queue — the node's first, or one after a tool call, above all after an approval
         * (D-062) — exactly as it holds a READY node: the slot is handed straight back and the turn
         * queues again once the run is resumed (FR-CTL-001/002, D110). The one exception is a node
         * that already started and is moving to a fallback model: it is RUNNING, and a pause lets it
         * finish.
         */
        async function takeTurn(continuing: boolean, withoutTools: boolean): Promise<TurnOutcome> {
          for (;;) {
            // PG-5.4: a replay holds no provider slot — nothing is sent to the provider.
            const gated =
              replayed === undefined
                ? deps.runGated
                : <T>(_providerId: Id, fn: () => Promise<T>): Promise<T> => fn();
            const outcome = await gated(
              chosen.providerId,
              async (): Promise<TurnOutcome | { kind: 'parked' }> => {
                if (input.signal.aborted) return { kind: 'cancelled' };
                if ((starting === undefined || continuing) && input.gate?.isPaused() === true) {
                  return { kind: 'parked' };
                }
                await started();
                try {
                  called = true;
                  return {
                    kind: 'called',
                    pendingCalls: await generateTurn(continuing, withoutTools),
                  };
                } finally {
                  // Still inside the gate: the next node's startedAt can never precede this endedAt.
                  input.onEnded?.();
                }
              },
            );
            if (outcome.kind !== 'parked') return outcome;
            // Queue again once the run is resumed; a stop while it waits ends it here (FR-CTL-002).
            if (input.gate === undefined || !(await input.gate.waitUntilDispatchable())) {
              return { kind: 'cancelled' };
            }
          }
        }

        /** One generate() call, streamed to the end; the tools it asked for, if any. */
        async function generateTurn(
          withResults: boolean,
          withoutTools: boolean,
        ): Promise<PendingToolCall[]> {
          adapter ??=
            replayed === undefined
              ? await deps.adapterFor(chosen.providerId)
              : createReplayAdapter(replayed);
          turnText = '';
          turnOpaque = undefined;
          /*
           * `execution.timeoutMs` is the node's own clock for one provider turn, and it starts here —
           * once the slot is held, never while the node queued for it (D66), and never across a tool
           * call or an approval a person takes their time over (D-062). `AbortSignal.timeout` sets a
           * `TimeoutError` reason, which the adapter reads to raise a retryable `network` failure
           * rather than a cancellation (D97, Arch §28). A tool enforces its own `timeoutMs` and is
           * cancelled only by the run's own stop signal.
           */
          const nodeTimeoutMs =
            node.kind === 'agent' || node.kind === 'model' ? node.config.execution.timeoutMs : 0;
          const timeoutMs =
            nodeTimeoutMs > 0 && isCliProviderType(adapter.type)
              ? Math.max(nodeTimeoutMs, CLI_SESSION_MIN_TIMEOUT_MS)
              : nodeTimeoutMs;
          const callSignal =
            timeoutMs > 0
              ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
              : input.signal;

          // A model the catalog says cannot call tools is not offered them (review I3): a local model
          // without tool support answers a request that carries them with an error.
          const offerTools =
            offeredTools.length > 0 && !withoutTools && modelTakesTools && replayed === undefined;
          const stream = adapter.generate(
            {
              modelId: chosen.modelId,
              system: prompt.system,
              prompt: prompt.text,
              outputTypes,
              ...(providerSchema === undefined ? {} : { jsonSchema: providerSchema }),
              ...(contract.maxTokens === undefined ? {} : { maxTokens: contract.maxTokens }),
              temperature,
              runId: input.runId,
              iteration: input.iteration,
              ...(workingDir === undefined ? {} : { workingDir }),
              // D375: a coding-agent CLI node with workspace access carries its access level and
              // the run's live allowlist; the adapter maps them to its own flags. Off sends nothing.
              ...(input.node.kind === 'agent' &&
              isAgentic(input.node.config) &&
              isCliProviderType(adapter.type) &&
              replayed === undefined
                ? {
                    cliAccess: {
                      access: agentWorkspaceOf(input.node.config).access,
                      allowedCommands: [
                        ...(deps.allowlistFor?.(input.runId)?.for(input.node.id) ??
                          agentWorkspaceOf(input.node.config).allowedCommands),
                      ],
                    },
                  }
                : {}),
              ...(offerTools ? { tools: offeredTools } : {}),
              // D377: an agentic node sends its turns so far, which supersede `toolResults`.
              ...(agent !== undefined
                ? { turns: agent.state.history }
                : withResults
                  ? { toolResults }
                  : {}),
            },
            callSignal,
          );

          const pendingCalls: PendingToolCall[] = [];
          for await (const chunk of stream as AsyncIterable<StreamChunk>) {
            switch (chunk.type) {
              case 'text':
                text += chunk.delta;
                turnText += chunk.delta;
                tokens.push(chunk.delta);
                break;
              case 'json':
                jsonValue = chunk.value;
                sawJson = true;
                break;
              case 'part':
                partChunks.push(
                  chunk.bytes === undefined
                    ? { part: chunk.part }
                    : { part: chunk.part, bytes: chunk.bytes },
                );
                break;
              case 'tool_call':
                pendingCalls.push({ callId: chunk.callId, name: chunk.name, args: chunk.args });
                break;
              case 'usage':
                // Summed across turns: every generate() turn is its own billed call (Arch §12.7).
                sawUsage = true;
                tokensIn += chunk.tokensIn;
                tokensOut += chunk.tokensOut;
                cachedTokensIn += chunk.cachedTokensIn ?? 0;
                if (chunk.costUsd !== undefined) {
                  reportedCostUsd = (reportedCostUsd ?? 0) + chunk.costUsd;
                }
                break;
              case 'activity':
                // The provider already did this (D261): logged for the inspector, never guarded.
                await logToolCall(
                  { callId: nextId(), name: activityToolName(chunk.tool), args: chunk.args },
                  {
                    status: chunk.status,
                    resultSummary: chunk.summary,
                    durationMs: chunk.durationMs,
                    verdicts: [],
                    at: deps.now?.() ?? new Date().toISOString(),
                  },
                );
                break;
              case 'model':
                modelUsed.resolvedModelId = chunk.modelId;
                break;
              case 'opaque':
                // D377: kept as this turn's record for the node's next call; never leaves the node.
                if (agent !== undefined) {
                  turnOpaque = { providerType: chunk.providerType, payload: chunk.payload };
                }
                break;
              case 'finish':
                finishReason = chunk.reason;
                break;
            }
          }
          return pendingCalls;
        }

        /**
         * One requested tool: the tool-point guardrails, then execution, logged either way
         * (round 4 §2.2, FR-TOOL-009). A `block` or a rejected approval fails the node
         * `GUARDRAIL_VIOLATION`; a tool that throws is logged `error`/`timeout` and its failure is
         * handed back to the model as an untrusted result, not treated as the node failing.
         */
        async function runToolCall(
          call: PendingToolCall,
          toolSignal: AbortSignal,
        ): Promise<{
          result?: unknown;
          failed?: { error: NodeError; failureReason: FailureReason };
        }> {
          const registered = deps.tools?.get(call.name);
          const at = deps.now?.() ?? new Date().toISOString();

          let step: ToolGuardStep;
          if (registered === undefined) {
            // An enabled name that resolves to no tool — a removed MCP server, say (§2.4). There is
            // no definition to check and nothing to run, so it is a block.
            step = {
              kind: 'block',
              reason: `The tool "${call.name}" is not registered.`,
            };
          } else if (input.guardrails?.beforeTool !== undefined) {
            step = await input.guardrails.beforeTool({
              definition: registered.definition,
              args: call.args,
              enabledTools,
              sandboxDir,
              allowedDomains,
            });
          } else {
            step = { kind: 'allow' };
          }

          /*
           * D-054: a Stop that landed while the checks ran — while a destructive call waited for its
           * approval, above all — never lets the tool run, whatever the decision said: the node is
           * STOPPED, and a destructive call after a Stop is exactly what the Stop is for. Thrown, so
           * the loop ends the node as a cancellation with what it spent.
           */
          if (toolSignal.aborted) {
            throw userCancelledError('The run was stopped before this tool call ran.');
          }

          verdicts.push(...(step.verdicts ?? []));

          /*
           * D375/D376: the person denied an agentic node's command. That is their answer, not the
           * node failing: the model reads it (and their note) and goes on, and the node is RUNNING
           * again (the approval service's `onDecided`). A policy `block` still fails the node.
           */
          if (agent !== undefined && step.kind === 'reject' && step.command === true) {
            await logToolCall(call, {
              status: 'rejected',
              resultSummary: step.reason,
              durationMs: 0,
              verdicts: step.verdicts ?? [],
              at,
              callId: call.callId,
            });
            return { result: deniedCommandResult(step.note) };
          }

          if (step.kind !== 'allow') {
            await logToolCall(call, {
              status: step.kind === 'block' ? 'blocked' : 'rejected',
              resultSummary: step.reason,
              durationMs: 0,
              verdicts: step.verdicts ?? [],
              at,
            });
            return {
              failed: {
                error: {
                  kind: 'guardrail',
                  code: step.kind === 'block' ? 'tool_blocked' : 'tool_rejected',
                  message: step.reason,
                  retryable: false,
                },
                failureReason: 'GUARDRAIL_VIOLATION',
              },
            };
          }

          let result: unknown;
          let status: 'ok' | 'error' | 'timeout' = 'ok';
          /** A failed call's message, the log's summary of it (FR-TOOL-009). */
          let failure: string | undefined;
          // D381: what an agentic node is doing right now, for its card; `tool.call` ends it.
          if (agent !== undefined && call.callId !== '') {
            const target = toolTarget(call.name, call.args, agent.state.backgroundCommands);
            await deps.bus.emitTransient({
              type: 'tool.started',
              workflowId: input.workflowId,
              runId: input.runId,
              payload: {
                runId: input.runId,
                nodeRunId: input.nodeRunId,
                nodeId: input.node.id,
                callId: call.callId.slice(0, TOOL_CALL_ID_MAX),
                name: call.name,
                ...(target === undefined ? {} : { target }),
              },
            });
          }
          try {
            result = await registered!.run(call.args, {
              runId: input.runId,
              nodeId: input.node.id,
              sandboxDir,
              signal: toolSignal,
              ...(workingDir === undefined ? {} : { projectDir: workingDir }),
            });
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
            status = isToolTimeout(error) ? 'timeout' : 'error';
            result = { error: failure, status };
          }
          // D381: a background command, so a later `command_output` can name what it checks.
          const processId = agent === undefined ? undefined : backgroundProcessOf(result);
          const command = (call.args as { command?: unknown } | null)?.command;
          if (
            processId !== undefined &&
            call.name === 'run_command' &&
            typeof command === 'string'
          ) {
            agent?.state.backgroundCommands.set(processId, command);
          }

          // What the model reads next passes the context point first, a failure's message included.
          const judged = await judgeToolResult(result);
          if (judged.failed !== undefined) {
            await logToolCall(call, {
              status: 'blocked',
              resultSummary: judged.failed.error.message,
              durationMs: durationSince(at),
              verdicts: step.verdicts ?? [],
              at,
              ...(agent === undefined ? {} : { callId: call.callId }),
            });
            return { failed: judged.failed };
          }
          // D378: the project files an agentic node's successful call changed, for its step summary.
          const changedPaths =
            agent === undefined || status !== 'ok'
              ? undefined
              : changedPathsOf(call.name, call.args, result, workingDir);
          await logToolCall(call, {
            status,
            resultSummary:
              failure !== undefined && judged.result === result
                ? failure
                : summariseResult(judged.result),
            durationMs: durationSince(at),
            verdicts: step.verdicts ?? [],
            at,
            ...(agent === undefined ? {} : { callId: call.callId }),
            ...(changedPaths === undefined ? {} : { changedPaths }),
          });
          return { result: judged.result };
        }

        /**
         * The context point over one tool result before the model reads it (round 5 §2.3,
         * FR-GRD-004): hidden instructions stripped, PII redacted per the policy, the verdicts
         * recorded on the node run by the hook. A `failed` step ends the node with its reason. With
         * nothing to change, or no hook, the result goes back exactly as the tool returned it.
         */
        async function judgeToolResult(
          result: unknown,
        ): Promise<
          | { result: unknown; failed?: undefined }
          | { failed: { error: NodeError; failureReason: FailureReason } }
        > {
          const judge = input.context?.toolResult;
          if (judge === undefined) return { result };
          const text = resultText(result);
          const step = await judge(text);
          verdicts.push(...(step.verdicts ?? []));
          if (step.kind === 'failed') {
            return { failed: { error: step.error, failureReason: step.failureReason } };
          }
          return { result: withJudgedText(result, text, step.text) };
        }

        /** Persist one logged ToolCall and emit its `tool.call` event (FR-TOOL-009, §2.5). */
        async function logToolCall(
          call: { callId: string; name: string; args: unknown },
          fields: {
            status: ToolCall['status'];
            resultSummary: string;
            durationMs: number;
            verdicts: Verdict[];
            at: string;
            /** D381: an agentic node's call id, which its `tool.started` frame named. */
            callId?: string;
            /** D378: the project files an agentic node's call changed. */
            changedPaths?: string[];
          },
        ): Promise<void> {
          const toolCall = buildToolCall({
            id: nextId(),
            nodeRunId: input.nodeRunId,
            toolName: call.name,
            args: call.args,
            resultSummary: fields.resultSummary.slice(0, TOOL_RESULT_SUMMARY_MAX),
            durationMs: fields.durationMs,
            status: fields.status,
            verdicts: fields.verdicts,
            at: fields.at,
            ...(fields.changedPaths === undefined ? {} : { changedPaths: fields.changedPaths }),
          });
          await deps.recordToolCall?.(input.runId, toolCall);
          const callId =
            fields.callId === undefined || fields.callId === ''
              ? undefined
              : fields.callId.slice(0, TOOL_CALL_ID_MAX);
          await deps.bus.emit({
            type: 'tool.call',
            workflowId: input.workflowId,
            runId: input.runId,
            payload: {
              runId: input.runId,
              nodeRunId: input.nodeRunId,
              toolCall,
              ...(callId === undefined ? {} : { callId }),
            },
          });
        }
      } catch (error) {
        tokens.stop();
        const nodeError = classifyError(error);

        /*
         * D309: a human message cut this turn short. What it had written is kept, never handed off,
         * and what it spent is estimated (characters ÷ 4, D313) when the provider had not yet said.
         */
        if (input.signal.aborted && isTurnAbortReason(input.signal.reason)) {
          const reported = tokensIn > 0 || tokensOut > 0;
          const spent: Usage = reported
            ? { ...usageNow(), source: 'reported' }
            : {
                tokensIn: estimateTokens(prompt.text),
                tokensOut: estimateTokens(text),
                costUsd: 0,
                source: 'estimated',
              };
          return {
            kind: 'done',
            result: await fail(input, nodeError, spent, {
              modelUsed,
              prompt: recordedPrompt(),
              ...(text === '' ? {} : { partialOutput: [{ type: 'text' as const, text }] }),
            }),
          };
        }

        const usage = usageNow();

        // Only these two are worth another model; everything else stops here (FR-RTR-002).
        if (nodeError.kind === 'provider' || nodeError.kind === 'network') {
          return { kind: 'retryable', error: nodeError, usage };
        }

        return {
          kind: 'done',
          result: await fail(input, nodeError, usage, {
            modelUsed,
            prompt: recordedPrompt(),
          }),
        };
      }

      tokens.stop();

      if (cancelled) {
        return {
          kind: 'done',
          result: await fail(
            input,
            userCancelledError(
              starting === undefined
                ? 'The run was stopped before this node run started.'
                : 'The run was stopped before this call was made.',
            ).nodeError,
            // A stop between two turns (D-062) keeps what the turns before it spent (FR-ERR-007).
            called ? usageNow() : NO_USAGE,
            {
              verdicts: [...verdicts],
              ...(called ? { modelUsed, prompt: recordedPrompt() } : {}),
            },
          ),
        };
      }

      /*
       * D313: a provider that reported no usage has its turn estimated — characters ÷ 4 on the
       * prompt and on what it wrote — marked `estimated`, so Track and Domain show the same numbers
       * and both say they are estimates.
       */
      if (!sawUsage && called) {
        tokensIn = estimateTokens(prompt.text);
        tokensOut = estimateTokens(text);
      }
      const usage: Usage =
        sawUsage || !called ? usageNow() : { ...usageNow(), source: 'estimated' };

      // D375: an agentic node's answer is its last turn's words, not its narration on the way.
      if (agent !== undefined) text = turnText;

      /*
       * A tool-point block or a rejected approval ends the node GUARDRAIL_VIOLATION (§2.2). The
       * offending ToolCall is already logged `blocked`/`rejected`; this is the node run's own end.
       */
      if (toolFailure !== undefined) {
        return {
          kind: 'done',
          result: await fail(input, toolFailure.error, usage, {
            modelUsed,
            prompt: recordedPrompt(),
            failureReason: toolFailure.failureReason,
            verdicts: [...verdicts],
          }),
        };
      }

      /* D375: the agentic node reached its Max turns or its token budget: RUN_FAILED, kind `agent`. */
      if (agentLimit !== undefined) {
        return {
          kind: 'done',
          result: await fail(input, agentLimit, usage, {
            modelUsed,
            prompt: recordedPrompt(),
            verdicts: [...verdicts],
          }),
        };
      }

      /*
       * The call limit was reached, the model was asked to finish without tools, and it asked for
       * one anyway: RUN_FAILED, kind `agent` (round 4 §2.2, FR-TOOL-003, TC-GRD-014).
       */
      if (toolLimitExceeded) {
        return {
          kind: 'done',
          result: await fail(
            input,
            {
              kind: 'agent',
              code: 'tool_call_limit',
              message: `The model kept requesting tools past its limit of ${toolCallLimit}.`,
              retryable: false,
            },
            usage,
            { modelUsed, prompt: recordedPrompt(), verdicts: [...verdicts] },
          ),
        };
      }

      /* A refusal is the model declining, which is an `agent` error, not a provider outage. */
      if (finishReason === 'refusal') {
        return {
          kind: 'done',
          result: await fail(
            input,
            {
              kind: 'agent',
              code: 'refusal',
              message: `The model declined to answer: ${text.trim()}`,
              retryable: false,
            },
            usage,
            { modelUsed, prompt: recordedPrompt() },
          ),
        };
      }

      /*
       * D310: the envelope blocks come out of the answer first, so a JSON node can write them too and
       * the contract judges only what is left. A block that is malformed, or that breaks the team's
       * rules, is the agent answering wrongly: CONTRACT_VIOLATION, with the reason the repair retry
       * hands back to it.
       */
      let teamEnvelopes: JudgedEnvelope[] | undefined;
      if (input.teamEnvelopes !== undefined && partChunks.length === 0) {
        const extracted = extractEnvelopeBlocks(text);
        const judged = input.teamEnvelopes.judge(extracted.blocks);
        if (!judged.ok) {
          return {
            kind: 'done',
            result: await fail(
              input,
              {
                kind: 'agent',
                code: 'contract_violation',
                message: judged.reason,
                retryable: false,
              },
              usage,
              { modelUsed, prompt: recordedPrompt(), failureReason: 'CONTRACT_VIOLATION' },
            ),
          };
        }
        text = extracted.text;
        teamEnvelopes = judged.envelopes;
      }

      /*
       * The output parts. A model that emitted `part` chunks (round 4 §2.6 `mock-media`) produced
       * them directly, so those *are* the output — each media part backed by a stored artifact
       * (FR-MM-003, FR-MM-004). Otherwise the answer is assembled from the streamed text and json.
       */
      let output: Part[];
      if (partChunks.length > 0) {
        if (deps.artifacts === undefined) {
          // Nowhere to store bytes: the parts pass through as the references they are.
          output = partChunks.map(({ part }) => part);
        } else {
          try {
            output = await deps.artifacts.store(partChunks);
          } catch (error) {
            /*
             * D-082: a media part the engine cannot back with a stored artifact — no bytes and no
             * artifact behind its id, or bytes the store refused. The model's output cannot be kept,
             * so the node fails with the reason rather than passing on a reference to nothing. Not
             * retryable: the same provider would hand back the same output.
             */
            return {
              kind: 'done',
              result: await fail(
                input,
                {
                  kind: 'provider',
                  code: 'media_not_stored',
                  message: `The model's media output could not be stored: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  retryable: false,
                },
                usage,
                {
                  modelUsed,
                  prompt: recordedPrompt(),
                  verdicts: [...verdicts],
                },
              ),
            };
          }
        }
      } else {
        output = [];
        const wantsJson = outputTypes.includes('json');

        if (wantsJson) {
          let value: unknown;
          if (sawJson) {
            value = jsonValue;
          } else {
            try {
              value = JSON.parse(text.trim());
            } catch {
              // BR-03: the model answered, it just answered wrongly. That is a contract violation,
              // never RUN_FAILED, and never a reason to retry a different provider.
              return {
                kind: 'done',
                result: await fail(
                  input,
                  {
                    kind: 'agent',
                    code: 'contract_violation',
                    message: `The model did not return valid JSON: ${text.trim().slice(0, 120)}`,
                    retryable: false,
                  },
                  usage,
                  {
                    modelUsed,
                    prompt: recordedPrompt(),
                    failureReason: 'CONTRACT_VIOLATION',
                  },
                ),
              };
            }
          }

          /*
           * Round 5 (§2.2, FR-MEM-002): `__memory` comes out here, after the parse and before the
           * output point and the contract, so neither ever sees it and it never reaches the next
           * node. A bad op is logged by its reason — never its value — and the answer still stands.
           */
          if (memoryOn) {
            const extracted = extractMemoryOps(value);
            value = extracted.value;
            memoryOps = extracted.ops;
            if (extracted.invalid !== undefined) {
              deps.logger.warn(
                {
                  subsystem: 'memory',
                  runId: input.runId,
                  nodeId: input.node.id,
                  nodeRunId: input.nodeRunId,
                  reason: extracted.invalid,
                },
                'memory ops ignored',
              );
            }
          }
          output.push({ type: 'json', value });
        }

        for (const type of outputTypes) {
          if (type === 'json') continue;
          if (type === 'code') output.push({ type: 'code', language: 'text', text: text.trim() });
          else if (type === 'text') output.push({ type: 'text', text: text.trim() });
        }
      }

      /*
       * The output point (§4 item 4, FR-GRD-007). When a guardrail engine is wired it owns the
       * contract check as well, so the output is validated once and a contract failure is still
       * `CONTRACT_VIOLATION` whatever the policy says (D85). It runs here, outside `runGated` and
       * before `node.output` is emitted: the provider slot is already free for whoever is waiting
       * (D66) and a masked secret is masked on the socket too (BR-07, D86).
       */
      let flowing = output;
      if (input.guardrails?.afterOutput !== undefined) {
        /*
         * D-054: an `ask_user` wait here ends when the run is stopped or shut down, and a decision
         * that lands as it is stopped does not un-stop the node — neither the output nor a guardrail
         * failure is written over the STOPPED the Stop already recorded (D111). The node keeps what
         * its call spent either way (FR-ERR-007, TC-OBS-002).
         */
        const stopped = async (error?: unknown): Promise<NodeExecutionOutcome> =>
          fail(
            input,
            stoppedError(error, "The run was stopped before this node's output was accepted."),
            usage,
            { modelUsed, prompt: recordedPrompt(), verdicts: [...verdicts] },
          );

        let checked: GuardrailStep<{ parts: Part[] }>;
        try {
          checked = await input.guardrails.afterOutput(flowing, contract);
        } catch (error) {
          if (!input.signal.aborted) throw error;
          return { kind: 'done', result: await stopped(error) };
        }
        verdicts.push(...(checked.verdicts ?? []));
        if (input.signal.aborted) return { kind: 'done', result: await stopped() };
        if (checked.kind === 'failed') {
          return {
            kind: 'done',
            result: await fail(input, checked.error, usage, {
              modelUsed,
              prompt: recordedPrompt(),
              failureReason: checked.failureReason,
              verdicts: [...verdicts],
            }),
          };
        }
        flowing = checked.parts;
      } else {
        const check = validateAgainstContract(flowing, contract);
        if (!check.ok) {
          return {
            kind: 'done',
            result: await fail(
              input,
              {
                kind: 'agent',
                code: 'contract_violation',
                message: check.reason,
                retryable: false,
              },
              usage,
              {
                modelUsed,
                prompt: recordedPrompt(),
                failureReason: 'CONTRACT_VIOLATION',
              },
            ),
          };
        }
      }

      /*
       * D310: the summaries are what the team reads, so the output point judges them too (no
       * contract: they are not the node's output), and they are secret-masked like everything stored.
       */
      if (teamEnvelopes !== undefined && teamEnvelopes.length > 0) {
        let summaries = teamEnvelopes.map((envelope) => envelope.summary);
        if (input.guardrails?.afterOutput !== undefined) {
          const checked = await input.guardrails.afterOutput(
            summaries.map((summary) => ({ type: 'text' as const, text: summary })),
          );
          verdicts.push(...(checked.verdicts ?? []));
          if (checked.kind === 'failed') {
            return {
              kind: 'done',
              result: await fail(input, checked.error, usage, {
                modelUsed,
                prompt: recordedPrompt(),
                failureReason: checked.failureReason,
                verdicts: [...verdicts],
              }),
            };
          }
          summaries = summaries.map((summary, index) => {
            const part = checked.parts[index];
            return part?.type === 'text' ? part.text : summary;
          });
        }
        teamEnvelopes = teamEnvelopes.map((envelope, index) => ({
          ...envelope,
          summary: maskSecrets(summaries[index] ?? envelope.summary),
        }));
      }

      /*
       * The memory ops apply only now, once the answer has been accepted: a rejected or failed
       * answer leaves memory as it was, and a retry never applies them twice. They are recorded as
       * stored — a key-shaped value masked (D86) — and only when there were any (FR-MEM-002).
       *
       * A store that refuses them fails the node (13a review m1): the answer was meant to leave
       * memory behind, and a node that silently did not would break the next run unseen. It fails
       * as an engine error — RUN_FAILED, never retried, since a retry would pay for the call again —
       * and it keeps what the call spent, its model and its prompt, so the node run and the run
       * totals still count the money (FR-OBS-002). `apply` is one transaction, so nothing was saved.
       */
      let applied: Pick<NodeExecutionOutcome, 'memoryOps'> = {};
      if (memoryOps.length > 0 && input.memory !== undefined && !input.signal.aborted) {
        try {
          await input.memory.apply(memoryOps);
        } catch (error) {
          deps.logger.error(
            {
              subsystem: 'memory',
              runId: input.runId,
              nodeId: input.node.id,
              nodeRunId: input.nodeRunId,
              err: error,
            },
            'memory ops could not be saved',
          );
          return {
            kind: 'done',
            result: await fail(input, memoryNotSavedError(), usage, {
              status: 'FAILED',
              failureReason: 'RUN_FAILED',
              modelUsed,
              prompt: recordedPrompt(),
              verdicts: [...verdicts],
            }),
          };
        }
        applied = {
          memoryOps: memoryOps.map((op): MemoryOp =>
            op.op === 'save' ? { ...op, value: maskMemoryValue(op.value) } : op,
          ),
        };
      }

      return {
        kind: 'done',
        result: await succeed(input, flowing, usage, {
          ...applied,
          ...(teamEnvelopes === undefined ? {} : { teamEnvelopes }),
          modelUsed,
          prompt: recordedPrompt(),
          verdicts: [...verdicts],
        }),
      };
    }
  }

  /* ---------------------------------------------------------------- others */

  async function executeOther(input: ExecuteNodeInput): Promise<NodeExecutionOutcome> {
    const node = input.node;
    const reads = readsOf(input.envelopes);

    switch (node.kind) {
      case 'input': {
        // FR-NODE-011: what the user typed at start wins over what the config remembers.
        const supplied = input.runInputs[node.id];
        let parts: Part[];
        if (supplied !== undefined && supplied.length > 0) {
          // A start request that carried parts (text and/or artifact references) wins whole
          // (FR-NODE-011): they are already the parts, media included.
          parts = supplied;
        } else {
          // The config's text, plus one media `Part` per attached artifact, resolved by MIME to
          // image/audio/video/file — references only, never bytes (FR-MM-003, FR-MM-004).
          parts =
            node.config.text === undefined || node.config.text === ''
              ? []
              : [{ type: 'text', text: node.config.text }];
          if (node.config.artifactIds.length > 0 && deps.artifacts !== undefined) {
            parts = [...parts, ...(await deps.artifacts.inputParts(node.config.artifactIds))];
          }
        }

        /*
         * §4 item 4 puts "the Input node content" at the **input** point, so the content the user
         * typed is checked on the node that produced it, with a verdict that says `input`. The
         * scheduler's adapter routes an Input node's `afterOutput` to `evaluateInput` for exactly
         * this; the executor only knows it has a hook to call before it announces the output.
         */
        if (input.guardrails?.afterOutput !== undefined) {
          const checked = await input.guardrails.afterOutput(parts);
          if (checked.kind === 'failed') {
            return fail(input, checked.error, NO_USAGE, {
              failureReason: checked.failureReason,
              ...(checked.verdicts === undefined ? {} : { verdicts: checked.verdicts }),
            });
          }
          return succeed(input, checked.parts, NO_USAGE, {
            ...(checked.verdicts === undefined ? {} : { verdicts: checked.verdicts }),
          });
        }

        return succeed(input, parts, NO_USAGE);
      }

      case 'output':
        // FR-NODE-012: an Output node is a terminal; what reaches it is the final result.
        return succeed(input, reads, NO_USAGE);

      case 'transform': {
        const result = runTransform(node.config, reads);
        if (!result.ok) {
          return fail(input, {
            kind: 'workflow',
            code: 'transform_failed',
            message: result.reason,
            retryable: false,
          });
        }
        return succeed(input, result.parts, NO_USAGE);
      }

      case 'retrieval': {
        // Round 5 §2.4 (FR-RAG-006): one search of the chosen base; every hit is a source (FR-RAG-007).
        if (deps.search === undefined) {
          return fail(input, {
            kind: 'invalid_config',
            code: 'knowledge_unavailable',
            message: 'This engine has no knowledge store, so a Retrieval node cannot search.',
            retryable: false,
          });
        }
        const result = await runRetrievalNode(node.config, reads, deps.search);
        // A base deleted mid-run is BLOCKED `missing_knowledge_base`, as pre-flight would have said.
        if (!result.ok) return fail(input, result.error);
        // The node run records what it read: the hits on its own envelope, beside its sources.
        return succeed(input, result.parts, NO_USAGE, {
          sources: result.sources,
          inputEnvelopes: withRetrieved(input.envelopes, result.retrieved),
        });
      }

      default:
        // Pre-flight refuses these kinds (§2.7 item 5), so reaching here is an engine bug.
        return fail(input, {
          kind: 'invalid_config',
          code: 'not_supported_yet',
          message: `A ${node.kind} node cannot be executed by this version.`,
          retryable: false,
        });
    }
  }

  return {
    async execute(input) {
      try {
        // PG-5.4: a replay answers from its recording; with none left, it fails without a call.
        const replay = input.replay;
        if (replay !== undefined && replay.kind === 'missing') {
          await input.onStarted?.();
          return await fail(
            input,
            { kind: 'workflow', code: 'replay_missing', message: replay.message, retryable: false },
            NO_USAGE,
            { status: 'FAILED', failureReason: 'RUN_FAILED' },
          );
        }
        if (replay !== undefined && input.node.kind === 'retrieval') {
          await input.onStarted?.();
          return await succeed(input, replay.output, NO_USAGE);
        }
        if (input.node.kind === 'agent' || input.node.kind === 'model') {
          return await executeAgent(input);
        }
        // Nothing to queue for: an input, transform or output node starts the moment it is dispatched.
        await input.onStarted?.();
        return await executeOther(input);
      } catch (error) {
        // D-054: the input point's `ask_user` wait — on an Input node's content or an agent's reads —
        // ends when the run is stopped or shut down; the node is STOPPED, not failed (FR-ERR-007).
        if (!input.signal.aborted) throw error;
        return fail(
          input,
          stoppedError(error, 'The run was stopped while this node was being checked.'),
        );
      }
    },
  };
}
