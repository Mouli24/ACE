import {
  allowedRunActions,
  DEFAULT_CONCURRENCY,
  ENVELOPE_SUMMARY_MAX,
  RunDomainConfigInputSchema,
  type BlockedReason,
  type BudgetHalt,
  type CursorQuery,
  type DayTotals,
  type Edge,
  type Envelope,
  type GuardrailPolicy,
  type Id,
  type Model,
  type Node,
  type NodeError,
  type NodeRun,
  type NodeState,
  type Page,
  type Part,
  type Provider,
  type ProviderCheckResult,
  type Run,
  type RunSummary,
  type StartRunRequest,
  type TurnTrigger,
  type TurnTriggerKind,
  type Usage,
  type ValidationIssue,
} from '@ace/contracts';

import { countLoop, digestLine, routeEnvelope as routeByBrain } from '../domain/brain.js';
import { budgetCrossing, isOverBudget } from '../domain/budget.js';
import {
  envelopeBody,
  judgeEnvelopeBlocks,
  type JudgedEnvelope,
} from '../domain/envelope-block.js';
import { autoExcerpt } from '../domain/projection.js';
import type { DomainRegistry } from '../domain/registry.js';
import {
  TURN_NOW_STATES,
  isTurnAbortReason,
  type EnvelopeDecision,
  type QueuedEnvelope,
  type QueuedMessage,
  type RunDomain,
  type TurnAbortReason,
} from '../domain/run-domain.js';
import type { TeamPromptInput } from '../prompts/index.js';

import type { ApprovalService } from '../approvals/index.js';
import type { BudgetService } from '../budgets/index.js';
import type { NodeRunTurn } from '../chat/service.js';
import { nodeWrites, undoUnavailableMessage } from '../checkpoints/writing.js';
import { goalOf, isGoalDriven } from '../graph/validate.js';
import { buildNodeContext } from '../context/builder.js';
import type { ContextGuard } from '../context/guard.js';
import type { SearchService } from '../knowledge/search.js';
import type { MemoryService } from '../memory/service.js';
import type { UsageService } from '../usage/index.js';
import type { EvaluationTarget, GuardrailEvaluator } from '../guardrails/evaluator.js';
import { policyRef, type PolicyService } from '../guardrails/policy-service.js';
import {
  asDelivered,
  contractFor,
  createTruncatingSummariser,
  estimatePartsTokens,
  readsBudgetFor,
  trustForSource,
  type Summariser,
} from '../envelopes/index.js';
import { buildEnvelope } from '../envelopes/index.js';
import {
  autoRetryDecision,
  failureReasonFor,
  upstreamFailedError,
  userCancelledError,
} from '../errors/index.js';
import type { EventBus } from '../events/index.js';
import { notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import { maskSecrets } from '../security/secret-patterns.js';
import type {
  CheckpointRecorder,
  CheckpointRecording,
  ModelRouter,
  ProviderAdapter,
  Repository,
  Scope,
} from '../ports/index.js';
import type { ProviderService } from '../providers/index.js';
import {
  DEFAULT_REPEATED_OUTPUT_TIMES,
  createLoopCoordinator,
  decideLoop,
  loopFailure,
  planNextIteration,
  retainedEnvelopes,
  splitOutgoing,
  type LoopContinue,
} from '../loops/index.js';
import { createSemaphore } from '../providers/semaphore.js';
import { createMergeArrivalLog, executeMergeNode, isMergeReady } from '../merge/index.js';
import { downstreamOf } from './control/graph.js';
import { createRunGate, type RunGate, type RunGateRegistry } from './control/gate.js';
import type { PartialRunPlan } from './control/service.js';
import { planStartFrom } from './control/start-from.js';
import { sumUsage } from './cost.js';
import { createSummaryUsageLedger } from './summary-usage.js';
import {
  createNodeExecutor,
  type ExecuteNodeInput,
  type NodeExecutionOutcome,
  type NodeExecutor,
  type NodeGuardrails,
} from './executor.js';
import { preflight } from './preflight.js';
import type { ArtifactMaterialiser, ToolGuardrailEvaluator, ToolProvider } from './tool-loop.js';
import type { ToolCall } from '@ace/contracts';
import { toSummary } from './summary.js';
import { createReplayBook, isReplayedKind, type ReplayBook } from './replay.js';

export * from './cost.js';
export * from './executor.js';
export * from './preflight.js';
export * from './tool-loop.js';
export * from './transform.js';
export * from './machines/index.js';
export * from './lifecycle.js';
export * from './control/index.js';
export * from './summary.js';
export * from './replay.js';
export * from './export.js';

/**
 * The run service and scheduler (FR-EXE-001..012, Arch §12.2, §12.3, BR-04).
 *
 * `startRun` freezes the snapshot with the run row in one transaction and then drives the graph
 * from that snapshot alone — never from the live tables. That is what makes TC-EXE-002 and
 * TC-NODE-008 true rather than merely intended: a node deleted or edited mid-run changes
 * nothing, because the scheduler is not looking at it.
 */

/** A run that has been recorded and pre-flighted, and the promise of its end. */
export interface BegunRun {
  /** The row as it stands once pre-flight is over: `RUNNING`, or `BLOCKED` with its issues. */
  run: Run;
  /** Settles with the final row when the scheduler stops driving the run. Never rejects. */
  done: Promise<Run>;
}

export interface RunService {
  /**
   * Records the run, pre-flights it and starts the scheduler in the background. This is what
   * `POST /workflows/:id/runs` answers with: the client subscribes after the response, so the run
   * must still be in flight when it arrives (§2.4, §5 item 6).
   */
  beginRun(workflowId: Id, request: StartRunRequest): Promise<BegunRun>;
  /** `beginRun` and then wait for the end — for callers that want the finished run. */
  startRun(workflowId: Id, request: StartRunRequest): Promise<Run>;
  getRun(runId: Id): Promise<Run>;
  listRuns(workflowId: Id, page: CursorQuery): Promise<Page<RunSummary>>;
  listNodeRuns(runId: Id): Promise<NodeRun[]>;
  getNodeRun(nodeRunId: Id): Promise<NodeRun>;

  /* Round 3: what `RunControls` is built on (FR-CTL-004, FR-CTL-005, FR-ERR-003, FR-ERR-004). */

  /**
   * Pre-flights and drives a run row somebody else recorded — the second half of `beginRun`. What
   * `POST /runs/:id/restart` answers with: the new run as it stands once it is under way, never at
   * its end (FR-CTL-004).
   */
  driveRecordedRun(run: Run): Promise<Run>;
  /**
   * PG-5.4: pre-flights and drives a replay row (`replayOf` set) somebody else recorded. Every
   * provider call — and every Retrieval search — is answered from the source run's recorded node
   * outputs: zero provider calls, no provider check, no budget, no checkpoint. A node with no
   * recording fails clearly. Resolves once the replay is under way, like `driveRecordedRun`.
   */
  driveReplayRun?(run: Run): Promise<Run>;
  /**
   * Re-opens a recorded run and drives the node runs in the plan, plus everything after them when
   * the plan says so (D81, FR-CTL-005, FR-ERR-003, FR-ERR-004). Resolves once it is going again.
   */
  drivePartialRun(plan: PartialRunPlan): Promise<Run>;
  /**
   * The envelopes a node would receive from the **latest** COMPLETED upstream outputs of this run —
   * what a re-run executes on (FR-CTL-005). Without it a re-run runs with no reads at all.
   */
  envelopesFor(run: Run, nodeId: Id): Promise<Envelope[]>;

  /**
   * D323: drive a run started from Domain that a previous engine process left open. No pre-flight
   * (it had one); its state is rebuilt from its rows and its log, and it parks again when idle.
   */
  resumeOpenRun(run: Run): Promise<Run>;

  /** Aborts every in-flight call and waits for the dispatch loops to unwind (FR-SYS-008). */
  shutdown(): Promise<void>;
  /** How many runs are still being driven by this process. */
  activeRunCount(): number;
}

export interface RunServiceDeps {
  repository: Repository;
  scope: Scope;
  bus: EventBus;
  logger: Logger;
  router: ModelRouter;
  adapterFor: (providerId: Id) => Promise<ProviderAdapter>;
  checkProvider: (providerId: Id) => Promise<ProviderCheckResult>;
  runGated: <T>(providerId: Id, fn: () => Promise<T>) => Promise<T>;
  /**
   * Which runs this process is driving (FR-CTL-001..003, D110). The scheduler registers a gate per
   * run and the controls look it up: it is the only thing a route handler and a running `drive()`
   * share, and it is owned by the composition root so both see the same map.
   */
  gates: RunGateRegistry;

  /*
   * Round 3's services. Optional, exactly as round 2's are on `EngineDeps`: a harness that only
   * exercises the scheduler builds a run service without them, and then nothing is checked, nothing
   * is budgeted and no approval can be asked for — never a crash.
   */

  /** Resolves the policy each node is judged against: project default → agent override (FR-GRD-002). */
  policies?: PolicyService;
  /** The input and output points, and the verdict store behind them (FR-GRD-003, 007, 011..015). */
  guardrails?: GuardrailEvaluator;
  /** The cost point: projected before a dispatch, actual after each node (FR-GRD-008, §2.3). */
  budgets?: BudgetService;
  /** `ask_user`: rejects whatever is still waiting when a run ends without an answer (FR-GRD-013). */
  approvals?: Pick<ApprovalService, 'cancelPending'>;
  /**
   * What a failed call proved about its provider — a key refused mid-run marks it AUTH_FAILED
   * (Arch §28, FR-ERR-001). The provider service's `recordStatus`, its one writer of provider state;
   * absent, a run changes no provider's state.
   */
  recordProviderStatus?: ProviderService['recordStatus'];

  summariser?: Summariser;
  now?: () => string;
  nextId?: () => string;
  tokenBatchMs?: number;

  /*
   * Round 4's tool loop and multimodal materialisation (Arch §12.7, FR-TOOL-*, FR-MM-003/004).
   * Optional like round 3's services: without them a run has no tools and no artifact store, and a
   * `tool_call` from a model fails the node rather than crashing. The gateway (Wave 3) binds them to
   * `@ace/tools`, the artifact store service and the tool-call repository.
   */

  /** The tool registry — built-ins plus connected MCP servers — a requested tool is looked up in. */
  tools?: ToolProvider;
  /** `<projectFolder>/.ace/sandbox/<runId>/` for one run (round 4 §2.2, NFR-SEC-03). */
  sandboxDirFor?: (runId: Id) => string;
  /** X1 §4.2: a run's project folder, for agent-route providers and the project tools. */
  projectFolderFor?: (runId: Id) => Promise<string | undefined>;
  /** Resolves Input `artifactIds` to parts and stores produced media parts as artifacts. */
  artifacts?: ArtifactMaterialiser;
  /** Persists a logged `ToolCall`, mirroring it onto its node run (FR-TOOL-009). */
  recordToolCall?: (runId: Id, call: ToolCall) => Promise<void>;
  /** The tool point of the guardrail engine (FR-GRD-005/006); absent, tools run unchecked. */
  toolGuardrails?: ToolGuardrailEvaluator;

  /*
   * Round 5's knowledge, memory, context guardrails and usage (§2.2–§2.6). Optional like the rounds
   * before: without them an attached base is not searched, memory is neither read nor written, the
   * context is placed unchecked, and a run's end carries no day totals — never a crash.
   */

  /** Hybrid search: an agent's implicit retrieval and the Retrieval node (FR-RAG-004..007). */
  search?: SearchService;
  /** The context point of the guardrail engine (FR-GRD-004); absent, context is placed unchecked. */
  contextGuard?: ContextGuard;
  /** An agent's long-term memory: read into its context, written from `__memory` (FR-MEM-002/003). */
  memory?: Pick<MemoryService, 'list' | 'apply' | 'markUsed'>;
  /** The day's totals a finished run announces with `usage.updated` (round 5 §2.8, FR-OBS-002). */
  usage?: Pick<UsageService, 'dayTotals'>;

  /**
   * D285: hands a finished Agent or Model node's goal and result (or failure) to its chat session —
   * the chat service's `recordRunTurn` — before the node's final state is announced, so a client
   * that hears the state can already read the turns. Absent, a run writes no chat. A failure here
   * is logged and never fails the run.
   */
  recordNodeTurn?: (turn: NodeRunTurn) => Promise<void>;

  /**
   * Domain (D309, D323): each drive's live conversation — the messages waiting for a node's turn, the
   * turn a message may cut short, and the wake-up a run started from Domain parks on. Absent, a run
   * takes no messages and ends as it always has.
   */
  domains?: DomainRegistry;

  /**
   * D300: each run in a project with a folder is one checkpoint — begun before the run drives and
   * finished when the drive settles (completed, halted or stopped). A Domain run that stays open
   * keeps recording until it ends. Absent, or failing, a run is never stopped by it.
   */
  checkpoints?: CheckpointRecorder;
}

/** Why one turn of a node started, and its own abort (D309). */
interface TurnContext {
  trigger: TurnTriggerKind;
  /** Absent without Domain, or for a node that takes no turns (a merge, a transform). */
  abort?: AbortController;
  /** D310: the envelopes this turn has delivered, across its attempts. */
  envelopes?: readonly QueuedEnvelope[];
}

/** D310: how a finished turn's output moves on, once its envelopes have been routed. */
interface TurnRouting {
  /** It sent a QUERY: its node run waits for the ANSWER. */
  waiting: boolean;
  /** Its output travels now, waits for the human (a held HANDOFF), or does not travel at all. */
  handoff: 'now' | 'held' | 'none';
  /** The HANDOFF envelope the output travels as. */
  envelopeId?: Id;
  /** The edges it travels along. */
  edges: Edge[];
}

/** A ≤120-character description of what crossed an edge (FR-EXE-015, §2.4). */
export function transferSummary(parts: readonly Part[]): string {
  const kinds = [...new Set(parts.map((part) => part.type))].join(', ');
  const tokens = estimatePartsTokens(parts);
  return `${kinds || 'nothing'} · ~${tokens} tokens`.slice(0, 120);
}

/**
 * What a drive is told about a run that has already been recorded (FR-CTL-005, FR-ERR-003/004).
 *
 * `nodeRuns` are the rows a control created and already answered a client with: they are executed
 * rather than created again. `withDownstream` extends that to everything reachable after them along
 * data edges (FR-ERR-004, D112). Everything the run already recorded is seeded as it was, so a
 * re-run of one node does not restart the graph.
 */
export interface DriveSeed {
  nodeRuns: readonly NodeRun[];
  withDownstream: boolean;
}

/**
 * What a node run the abort caught before it started records: a cancellation, never a failure
 * (FR-ERR-007, Arch §28's `user_cancelled`).
 */
function cancelledBeforeStart(): NodeError {
  return userCancelledError('The run was stopped before this node run started.').nodeError;
}

/**
 * What a node run records when the engine itself could not finish it (FR-EXE-011): Arch §28's
 * `workflow` kind with the contract's `internal` code — nothing a retry of the same call would fix,
 * and nothing about the provider. The details are in the engine log, not on the row.
 */
function engineFailure(): NodeError {
  return {
    kind: 'workflow',
    code: 'internal',
    message:
      'The engine could not finish this node run, so it failed. The engine log has the details.',
    retryable: false,
  };
}

/**
 * A copy of what a node read, fit to store: every string through the same mask the stored prompt
 * goes through (BR-07, D86). A retrieved chunk is a document's text, and a document may hold a
 * key-shaped string the prompt record already masks; the row must not be the one place it is kept.
 */
function maskedForStorage<T>(value: T): T {
  if (typeof value === 'string') return maskSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => maskedForStorage(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskedForStorage(item)]),
    ) as T;
  }
  return value;
}

/** Two totals that count the same tokens and the same money. */
function sameUsage(a: Usage, b: Usage): boolean {
  return a.tokensIn === b.tokensIn && a.tokensOut === b.tokensOut && a.costUsd === b.costUsd;
}

/** Run states that are an ending (Arch §19.2): nothing writes over them. */
const ENDED_STATES: ReadonlySet<Run['status']> = new Set<Run['status']>([
  'COMPLETE',
  'HALTED',
  'BLOCKED',
]);

/** Node states that mean the run still has work in flight (Arch §19.2). */
const BUSY_STATES: ReadonlySet<NodeState> = new Set<NodeState>(['RUNNING', 'READY', 'WAITING']);

export function createRunService(deps: RunServiceDeps): RunService {
  const { repository, scope, bus, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;
  const summariser = deps.summariser ?? createTruncatingSummariser();
  /** Summariser usage per run and target node, until the target's node run is recorded and takes it (F5). */
  const summaryUsage = createSummaryUsageLedger();
  /** PG-5.4: the replays this process is driving, by replay run id, and what answers them. */
  const replays = new Map<Id, ReplayBook>();
  /** A replay summarises by truncation: a model summary would be a provider call. */
  const replaySummariser = createTruncatingSummariser();

  const executor: NodeExecutor = createNodeExecutor({
    bus,
    logger,
    adapterFor: deps.adapterFor,
    modelsFor: () => repository.models.list(scope, {}),
    // PG-1.4 (D359): local is $0 by rule, an unpriced remote model's cost is unknown.
    providerFor: async (providerId) =>
      (await repository.providers.get(scope, providerId)) ?? undefined,
    runGated: deps.runGated,
    router: deps.router,
    ...(deps.tokenBatchMs === undefined ? {} : { tokenBatchMs: deps.tokenBatchMs }),
    // Round 4: the tool loop and multimodal materialisation, threaded through from the gateway.
    ...(deps.tools === undefined ? {} : { tools: deps.tools }),
    ...(deps.sandboxDirFor === undefined ? {} : { sandboxDirFor: deps.sandboxDirFor }),
    ...(deps.projectFolderFor === undefined ? {} : { projectFolderFor: deps.projectFolderFor }),
    ...(deps.artifacts === undefined ? {} : { artifacts: deps.artifacts }),
    ...(deps.recordToolCall === undefined ? {} : { recordToolCall: deps.recordToolCall }),
    ...(deps.nextId === undefined ? {} : { nextId: deps.nextId }),
    // Round 5: the Retrieval node's search (§2.4, FR-RAG-006).
    ...(deps.search === undefined ? {} : { search: deps.search }),
  });

  /** Every run this process is currently driving, so shutdown can abort them (FR-SYS-008). */
  const active = new Map<Id, { gate: RunGate; done: Promise<void> }>();

  async function emitNodeState(
    run: Run,
    nodeRun: NodeRun,
    status: NodeState,
    failureReason?: NodeRun['failureReason'],
    /** D303: a turn's RUNNING frame says why it started; its last frame says how long it took. */
    extra: { trigger?: TurnTrigger; durationMs?: number } = {},
  ): Promise<void> {
    await bus.emit({
      type: 'node.state',
      workflowId: run.workflowId,
      runId: run.id,
      payload: {
        runId: run.id,
        nodeRunId: nodeRun.id,
        nodeId: nodeRun.nodeId,
        iteration: nodeRun.iteration,
        attempt: nodeRun.attempt,
        status,
        ...(failureReason === undefined ? {} : { failureReason }),
        ...(extra.trigger === undefined ? {} : { trigger: extra.trigger }),
        ...(extra.durationMs === undefined ? {} : { durationMs: extra.durationMs }),
      },
    });
  }

  /**
   * One envelope, from one node to one node (Arch §12.4, BR-02).
   *
   * Written once and used twice: by the scheduler's `deliver` while a run is going, and by
   * `envelopesFor` when a control rebuilds what a node would read from the latest upstream outputs
   * (FR-CTL-005). Two copies of this arithmetic would be two answers to "what did that node read?".
   */
  async function envelopeBetween(
    run: Run,
    from: Node,
    to: Node,
    parts: Part[],
    iteration: number,
    options: {
      /** False when a control only rebuilds what a node would read: nothing is spent on its behalf. */
      record?: boolean;
      /** The run's abort signal, so a Stop cancels a model summary under way (round 5 §2.5). */
      signal?: AbortSignal;
    } = {},
  ): Promise<Envelope> {
    const { record = true, signal } = options;
    // An agent's reads leave room for its retrieved chunks and memory (round 5 §2.2, §2.4).
    const budgetTokens = to.kind === 'agent' ? readsBudgetFor(to) : Number.MAX_SAFE_INTEGER;
    const outputTypes =
      to.kind === 'agent' || to.kind === 'model' ? to.config.outputTypes : ['text' as const];

    // The receiving node's own model summarises for it (round 5 §2.5, F3), cancelled with the run
    // when the caller has the run's signal to hand.
    const target =
      (to.kind === 'agent' || to.kind === 'model') &&
      to.config.providerId !== undefined &&
      to.config.modelId !== undefined
        ? { providerId: to.config.providerId, modelId: to.config.modelId }
        : undefined;

    /*
     * BR-13 (final-review I4): a model summary sends untrusted upstream text to a model, so the
     * context guard sees it first, under the receiving node's policy — hidden instructions stripped,
     * PII redacted; refused text is truncated, never sent. No node run exists while an envelope is
     * built, so its verdicts have nothing to be recorded against and are not recorded: the summary
     * itself is judged again as an upstream read by that node's own context step.
     */
    const guard = deps.contextGuard;
    const sanitise =
      guard === undefined || target === undefined
        ? undefined
        : async (text: string): Promise<string | null> => {
            const policy =
              deps.policies === undefined ? null : await deps.policies.resolve(run.projectId, to);
            const judged = await guard.inspect({
              target: {
                runId: run.id,
                workflowId: run.workflowId,
                nodeRunId: '',
                nodeId: to.id,
                nodeName: to.name,
                iteration,
                policy,
                ...(signal === undefined ? {} : { signal }),
              },
              label: 'upstream',
              text,
            });
            return judged.kind === 'failed' ? null : judged.text;
          };

    const { envelope, usage } = await buildEnvelope(
      {
        id: nextId(),
        runId: run.id,
        fromNodeId: from.id,
        toNodeId: to.id,
        iteration,
        parts,
        budgetTokens,
        // BR-13: only an Input node's content is trusted.
        trust: trustForSource(from.kind),
        contract: contractFor(
          outputTypes,
          to.kind === 'agent' ? to.config.outputContract?.jsonSchema : undefined,
        ),
        createdAt: now(),
        ...(target === undefined ? {} : { target }),
        ...(signal === undefined ? {} : { signal }),
        ...(sanitise === undefined ? {} : { sanitise }),
      },
      replays.has(run.id) ? replaySummariser : summariser,
    );

    // F5: a summarisation call is the receiving node's spend, carried until its run is recorded.
    if (usage !== undefined && record) summaryUsage.add(run.id, to.id, usage);

    return envelope;
  }

  /** The latest attempt of the latest iteration of each node, from a run's whole node-run list. */
  function latestByNode(rows: readonly NodeRun[]): Map<Id, NodeRun> {
    const latest = new Map<Id, NodeRun>();
    for (const row of rows) {
      const seen = latest.get(row.nodeId);
      const newer =
        seen === undefined ||
        row.iteration > seen.iteration ||
        (row.iteration === seen.iteration && row.attempt >= seen.attempt);
      if (newer) latest.set(row.nodeId, row);
    }
    return latest;
  }

  /* ------------------------------------------------------------- readiness */

  /**
   * A node is ready when every input port that has edges has what it needs: all of them for a
   * single-input port, at least one for a `multi` port (§2.6 of round 1's port model, Arch §12.3).
   */
  function isReady(node: Node, edges: readonly Edge[], delivered: ReadonlySet<Id>): boolean {
    /*
     * A merge is the one node whose readiness is not a property of its ports (FR-PAR-002): both of
     * its input ports are `multi`, so the generic rule below *is* the `any` behaviour and `all`
     * would be unreachable. `isMergeReady` reads the mode instead.
     */
    if (node.kind === 'merge') return isMergeReady(node, edges, delivered);

    /*
     * Data edges only. A loop edge into this node is not a precondition for running it — it points
     * backwards (D73), so requiring it would deadlock the very first iteration of every loop. The
     * loop re-queues its target instead, which is `requeue` below.
     */
    const incoming = edges.filter((edge) => edge.to.nodeId === node.id && edge.kind === 'data');
    if (incoming.length === 0) return true;

    const byPort = new Map<string, Edge[]>();
    for (const edge of incoming) {
      byPort.set(edge.to.portId, [...(byPort.get(edge.to.portId) ?? []), edge]);
    }

    for (const [portId, portEdges] of byPort) {
      const port = node.inputs.find((candidate) => candidate.id === portId);
      const needed = port?.multi === true ? 1 : portEdges.length;
      const arrived = portEdges.filter((edge) => delivered.has(edge.id)).length;
      if (arrived < needed) return false;
    }

    return true;
  }

  /*
   * D112: "everything downstream" walks **data edges only**, which is `downstreamOf` in
   * `control/graph.ts`. A loop edge points backwards by construction (D73), so following it would
   * make every node in a loop body downstream of every other — and `blockDownstream` on a failing
   * loop source would reach back into its own body and block the Writer that feeds it. The
   * scheduler's own copy of this walk did exactly that; it was harmless only while loop edges were
   * refused.
   */

  /* ------------------------------------------------------------- the drive */

  async function drive(
    run: Run,
    gate: RunGate,
    seed?: DriveSeed,
    /** Domain (D309, D323): this run's live conversation; absent, the run takes no messages. */
    domain?: RunDomain,
  ): Promise<Run> {
    const signal = gate.signal;
    const { nodes, edges } = run.snapshot;
    const settings = await repository.settings.get(scope);
    const limit = settings.concurrency > 0 ? settings.concurrency : DEFAULT_CONCURRENCY;
    /** D323: started from Domain — when the graph has nothing left to do, the run parks. */
    const stayOpen = run.domain?.stayOpen === true;
    // D305, D323: a run re-opened after a restart while paused or BLOCKED mid-run stays held until
    // a resume, exactly as it was.
    if (run.status === 'PAUSED' || (run.status === 'BLOCKED' && run.blockedReason !== undefined)) {
      gate.pause();
    }

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const states = new Map<Id, NodeState>(nodes.map((node) => [node.id, 'IDLE' as NodeState]));
    const nodeRunByNode = new Map<Id, NodeRun>();
    /** When each node run went RUNNING (D66: started, not queued), so its `durationMs` can be measured. */
    const startedAtByNodeRun = new Map<Id, string>();
    const envelopesFor = new Map<Id, Envelope[]>();
    const deliveredEdges = new Set<Id>();
    const usages: Usage[] = [];
    const finalOutput: Record<Id, Part[]> = {};
    /** What arrived at each merge node, in order and with its port (FR-PAR-002, §2.4). */
    const mergeArrivals = createMergeArrivalLog();
    /** Which node belongs to which loop, what each has repeated, what each last produced (§2.4). */
    const loops = createLoopCoordinator(edges);
    /** The iteration each node is at. Only a loop body node ever climbs (FR-PAR-005). */
    const iterations = new Map<Id, number>(nodes.map((node) => [node.id, 1]));
    /** The policy each node was judged against, so the loop point can read its params (FR-GRD-002). */
    const policyByNode = new Map<Id, GuardrailPolicy>();
    /** Set once, by the first cap a node crossed; the run then dispatches nothing more (§2.3, D80). */
    let budgetHalt: BudgetHalt | undefined;
    /**
     * Node runs someone else already created for this drive to execute: the row a retry, a re-run or
     * Start-from made. `dispatch` consumes the row rather than creating a second one, because the
     * client is already holding that row's id (FR-CTL-005, FR-ERR-003, FR-EXE-013).
     */
    const plannedRuns = new Map<Id, NodeRun>();
    /** The catalogue, read once: the cost point needs the price of the model a node would use. */
    const catalog = await repository.models.list(scope, {});
    const providerRows = await repository.providers.list(scope);
    /** D313: each provider's type, so a turn's usage says which kind of provider spent it. */
    const providerTypes = new Map(providerRows.map((provider) => [provider.id, provider.type]));
    /**
     * PG-5.1 (D341, D361): each step of a node that can write the project folder is a checkpoint
     * of its own, `{ kind: 'run', runId, nodeId }`, so one node's work can be reverted alone. The
     * steps of writing nodes take turns (one at a time per run), so each checkpoint holds only its
     * own node's changes; reading nodes run alongside as before.
     */
    const writers = await writingNodes(run, providerRows);
    const writeTurns = createSemaphore(1);

    /*
     * Domain (D309, D323). A node may take more turns than the graph gives it — a human message, a
     * re-run of what it feeds — and each is its own node run, at the same iteration, attempt + 1.
     */
    /** The highest attempt recorded per `node:iteration`, so a further turn never reuses one (D95). */
    const lastAttempt = new Map<string, number>();
    const attemptKey = (nodeId: Id, iteration: number): string => `${nodeId}:${iteration}`;
    const nextAttemptFor = (nodeId: Id, iteration: number): number =>
      (lastAttempt.get(attemptKey(nodeId, iteration)) ?? 0) + 1;
    /** Nodes that completed an iteration in this drive: completing it again is a fresh HANDOFF. */
    const completedIterations = new Set<string>();
    /** The state a node was in before a turn an End cut short, so the end reads the graph as it was. */
    const stateBeforeTurn = new Map<Id, NodeState>();
    /** Successors handed a fresh envelope while busy: they run again once their turn is over. */
    const staleSuccessors = new Set<Id>();
    /** Each node run's own signal — the run's, or that and its turn's (D309). */
    const turnSignals = new Map<Id, AbortSignal>();
    domain?.attachStates(() => Object.fromEntries(states));

    /* D304, D310: the team as envelopes name it, and the askers waiting on an ANSWER. */
    const roster = domain?.roster ?? [];
    const onRoster = new Set(roster.map((entry) => entry.nodeId));
    const brainId = roster.find((entry) => entry.brain)?.nodeId;
    const labelOf = (nodeId: Id): string => {
      const handle = roster.find((entry) => entry.nodeId === nodeId)?.handle;
      return handle === undefined ? (nodeById.get(nodeId)?.name ?? nodeId) : `@${handle}`;
    };
    /** The QUERY turn each asker is waiting on, until its next turn closes it. */
    const waitingRows = new Map<Id, NodeRun>();
    const dataEdgesFrom = (nodeId: Id): Edge[] =>
      edges.filter((edge) => edge.kind === 'data' && edge.from.nodeId === nodeId);

    /**
     * The policy this node is judged against (FR-GRD-002): the agent's override, else the project
     * default. Resolved once per node and remembered, so the node run's `guardrailPolicy` ref, the
     * output point and the loop point all name the same version.
     */
    async function resolvePolicy(node: Node): Promise<GuardrailPolicy | null> {
      const known = policyByNode.get(node.id);
      if (known !== undefined) return known;
      if (deps.policies === undefined) return null;

      const policy = await deps.policies.resolve(run.projectId, node);
      if (policy !== null) policyByNode.set(node.id, policy);
      return policy;
    }

    /** What a guardrail or a budget check is told about the node run it is judging. */
    function targetFor(node: Node, nodeRun: NodeRun): EvaluationTarget {
      return {
        runId: run.id,
        workflowId: run.workflowId,
        nodeRunId: nodeRun.id,
        nodeId: node.id,
        nodeName: node.name,
        iteration: nodeRun.iteration,
        policy: policyByNode.get(node.id) ?? null,
        // An approval wait at any point ends when the run is stopped or shut down (D-054) — or
        // when a human message cuts the turn short (D309).
        signal: turnSignals.get(nodeRun.id) ?? signal,
      };
    }

    /**
     * The guardrail points for one node run (FR-GRD-003, 007, 011..015, Arch §13.1).
     *
     * The executor calls these and knows nothing else about guardrails: it does not resolve a
     * policy, does not store a verdict — every verdict goes through `guardrailVerdicts.append`
     * inside the evaluator, never by patching the node run (D101) — and does not know what
     * `ask_user` means. `undefined` when the app was built without an evaluator, in which case the
     * executor validates the contract itself, which is the round-2 behaviour.
     */
    function guardrailsFor(node: Node, nodeRun: NodeRun): { guardrails?: NodeGuardrails } {
      const evaluator = deps.guardrails;
      const toolEvaluator = deps.toolGuardrails;
      // Nothing to wire when neither the output/input engine nor the tool point is present.
      if (evaluator === undefined && toolEvaluator === undefined) return {};
      const target = targetFor(node, nodeRun);
      const policy = policyByNode.get(node.id) ?? null;

      /*
       * The tool point (round 4 §2.2, FR-GRD-005/006). The executor builds the `ToolPointInput` bag
       * from the node it is running; the scheduler adds the resolved policy and the node-run target,
       * so the guardrail evaluator has everything to run `checkToolArgs`, the four policy checks and,
       * for a destructive tool, the Round 3 approval flow. The cap `maxToolCalls` is the policy's
       * `max_tool_calls`, min'd against the agent's own limit inside the executor (§2.2).
       */
      const toolFields: Pick<NodeGuardrails, 'maxToolCalls' | 'beforeTool'> =
        toolEvaluator === undefined
          ? {}
          : {
              ...(() => {
                const cap = toolEvaluator.toolCallCap(policy);
                return cap === undefined ? {} : { maxToolCalls: cap };
              })(),
              beforeTool: (bag) => toolEvaluator.evaluateTool({ target, ...bag }),
            };

      // The input/output points need the full evaluator; the tool point can stand alone.
      if (evaluator === undefined) {
        return { guardrails: toolFields };
      }

      return {
        guardrails: {
          ...toolFields,
          async beforePrompt(envelopes) {
            const outcome = await evaluator.evaluateEnvelopes({ target, envelopes });
            return outcome.kind === 'failed'
              ? {
                  kind: 'failed',
                  failureReason: outcome.failureReason,
                  error: outcome.error,
                  verdicts: outcome.verdicts,
                }
              : { kind: 'continue', envelopes: outcome.envelopes, verdicts: outcome.verdicts };
          },

          async afterOutput(parts, contract) {
            /*
             * §4 item 4 puts "the Input node content" at the **input** point, so an Input node's
             * output is judged there and its verdicts say `input`. Everything else is the output
             * point, where the contract is decided too (D85).
             */
            const outcome =
              node.kind === 'input'
                ? await evaluator.evaluateInput({ target, parts })
                : await evaluator.evaluateOutput({
                    target,
                    parts,
                    ...(contract === undefined ? {} : { contract }),
                  });

            return outcome.kind === 'failed'
              ? {
                  kind: 'failed',
                  failureReason: outcome.failureReason,
                  error: outcome.error,
                  verdicts: outcome.verdicts,
                }
              : { kind: 'continue', parts: outcome.parts, verdicts: outcome.verdicts };
          },
        },
      };
    }

    /**
     * The round 5 hooks for one node run (§2.2–§2.4, FR-GRD-004, FR-MEM-002).
     *
     * `context` is built for an agent or Model node whenever there is something for it to do — a
     * context guard to judge upstream reads with, or an agent with a knowledge base or memory on —
     * and never otherwise, so a plain agent in a build without the round 5 services reads exactly
     * what round 4 delivered. It hands `buildNodeContext` the agent's stored memory (only when memory
     * is on), the search, the guard and this node run as the target, and stamps `lastUsedAt` on the
     * memory entries it placed. `memory` is the agent's memory switch and `MemoryService.apply`.
     *
     * For an agent with a knowledge base or memory, a context step that succeeds also stores the
     * envelopes it built on the node run, in place of the ones delivered (13a review I2): they are
     * what the prompt was assembled from, and `GET /node-runs/:id` must show the chunks and the
     * memory it read (FR-RAG-007, FR-MEM-003). Any other node keeps its delivered envelopes byte for
     * byte, whatever the guard did to its prompt.
     *
     * With a context guard, the hook also judges each tool result before the model reads it, with
     * the `tool` label (FR-GRD-004, R5 §2.3).
     */
    function contextFor(
      node: Node,
      nodeRun: NodeRun,
    ): Pick<ExecuteNodeInput, 'context' | 'memory'> {
      if (node.kind !== 'agent' && node.kind !== 'model') return {};
      const memoryService = deps.memory;
      const memoryOn = node.kind === 'agent' && node.config.memory?.enabled === true;
      const hasBases = node.kind === 'agent' && (node.config.knowledgeBaseIds?.length ?? 0) > 0;
      /** Where this node's memory is read from: nowhere when memory is off or not wired. */
      const reader = memoryOn ? memoryService : undefined;
      /**
       * Stamps `lastUsedAt` on the entries placed. Best effort (13a review m1): the stamp is
       * bookkeeping, so a store that refuses it is logged and never fails a node about to make its
       * call — or one that already has.
       */
      const markUsed = async (ids: readonly Id[]): Promise<void> => {
        try {
          await reader?.markUsed(ids);
        } catch (error) {
          logger.warn(
            {
              subsystem: 'memory',
              runId: run.id,
              nodeId: node.id,
              nodeRunId: nodeRun.id,
              err: error,
            },
            'could not mark memory entries used',
          );
        }
      };

      const guard = deps.contextGuard;
      const context: Pick<ExecuteNodeInput, 'context'> =
        guard === undefined && !hasBases && reader === undefined
          ? {}
          : {
              context: {
                async build(envelopes, runSignal) {
                  const step = await buildNodeContext({
                    node,
                    envelopes,
                    memory: reader === undefined ? [] : await reader.list(node.id),
                    // PG-5.4: a replay embeds nothing — no knowledge search, which would call a provider.
                    search: replays.has(run.id) ? undefined : deps.search,
                    guard,
                    target: targetFor(node, nodeRun),
                    signal: runSignal,
                  });
                  // A node the Stop ends STOPPED used nothing and read nothing (13a review m3).
                  if (step.kind !== 'continue' || runSignal.aborted) return step;
                  if (step.usedMemoryIds.length > 0) await markUsed(step.usedMemoryIds);
                  if (hasBases || reader !== undefined) {
                    await repository.nodeRuns.update(scope, nodeRun.id, {
                      inputEnvelopes: maskedForStorage(step.envelopes),
                    });
                  }
                  return step;
                },
                ...(guard === undefined
                  ? {}
                  : {
                      // FR-GRD-004: a tool result is judged with the `tool` label before the
                      // model reads it, its verdicts recorded on this node run (R5 §2.3).
                      async toolResult(text: string) {
                        const judged = await guard.sanitise({
                          target: targetFor(node, nodeRun),
                          label: 'tool',
                          text,
                        });
                        return judged.kind === 'failed'
                          ? {
                              kind: 'failed' as const,
                              failureReason: failureReasonFor(judged.error),
                              error: judged.error,
                              verdicts: judged.verdicts,
                            }
                          : {
                              kind: 'continue' as const,
                              text: judged.text,
                              verdicts: judged.verdicts,
                            };
                      },
                    }),
              },
            };

      return {
        ...context,
        ...(node.kind === 'agent' && memoryService !== undefined
          ? {
              memory: {
                enabled: memoryOn,
                apply: (ops) => memoryService.apply(node.id, ops),
              },
            }
          : {}),
      };
    }

    /** The price row of the model this node would call, for the projected cost (§2.3). */
    function pricingFor(node: Node): { pricing?: (typeof catalog)[number]['pricing'] } {
      if (node.kind !== 'agent' && node.kind !== 'model') return {};
      const { providerId, modelId } = node.config;
      const row = catalog.find(
        (model) => model.providerId === providerId && model.modelId === modelId,
      );
      return row?.pricing === undefined ? {} : { pricing: row.pricing };
    }

    /**
     * The `loop` point's params from the policy this node was judged against (§2.2, §2.4).
     *
     * `repeatedOutputTimes` absent means the check is not configured and FR-GRD-009 does not fire,
     * which is why it is read from the policy rather than defaulted here: a project that switched
     * `repeated_output` off must get a loop that only its own maximum stops.
     */
    function loopPointParams(nodeId: Id): {
      policyMaxIterations?: number;
      repeatedOutputTimes?: number;
    } {
      const checks = (policyByNode.get(nodeId)?.checks ?? []).filter(
        (check) => check.enabled && check.point === 'loop',
      );
      const positive = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

      const max = checks.find((check) => check.type === 'max_iterations');
      const repeat = checks.find((check) => check.type === 'repeated_output');

      return {
        ...(max === undefined
          ? {}
          : (() => {
              const value = positive(max.params['max']) ?? positive(max.params['maxIterations']);
              return value === undefined ? {} : { policyMaxIterations: value };
            })()),
        ...(repeat === undefined
          ? {}
          : {
              repeatedOutputTimes:
                positive(repeat.params['times']) ?? DEFAULT_REPEATED_OUTPUT_TIMES,
            }),
      };
    }

    /**
     * One node run row per node per iteration, created when that iteration is dispatched — and one
     * more per automatic retry, created before its backoff starts (FR-ERR-005).
     *
     * A row born after the run was aborted is born STOPPED: nothing will ever start it, and a row
     * left READY inside a HALTED run would be a node the Canvas shows as still queued (FR-CTL-003).
     * One born while the run is paused is born PAUSED (D111): `pause` flips the gate before it lists
     * the READY rows (D110), so a row created after the flip is one it never sees — a retry that
     * falls due while the run is paused, say.
     */
    async function beginNodeRun(
      node: Node,
      iteration: number,
      attempt = 1,
      /** D309: why this turn starts; absent for an ordinary dispatch that carries no message. */
      trigger?: TurnTrigger,
    ): Promise<NodeRun> {
      const aborted = signal.aborted;
      const key = attemptKey(node.id, iteration);
      lastAttempt.set(key, Math.max(lastAttempt.get(key) ?? 0, attempt));
      const nodeRun: NodeRun = {
        id: nextId(),
        runId: run.id,
        nodeId: node.id,
        iteration,
        attempt,
        ...(trigger === undefined ? {} : { trigger }),
        status: aborted ? 'STOPPED' : gate.isPaused() ? 'PAUSED' : 'READY',
        ...(aborted ? { error: cancelledBeforeStart(), endedAt: now() } : {}),
        inputEnvelopes: envelopesFor.get(node.id) ?? [],
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        verdicts: [],
        approvals: [],
        toolCalls: [],
        // FR-GRD-002: which policy, at which version, judged this node run — recorded on the row so
        // "what was this run checked against?" still has an answer a year later (BR-04, Arch §13.4).
        ...(() => {
          const policy = policyByNode.get(node.id);
          return policy === undefined ? {} : { guardrailPolicy: policyRef(policy) };
        })(),
        // No startedAt yet: it is stamped when the node starts, not when it joins its provider's
        // queue (D66).
      };

      await repository.nodeRuns.create(scope, nodeRun);
      nodeRunByNode.set(node.id, nodeRun);
      await emitNodeState(run, nodeRun, nodeRun.status);
      return nodeRun;
    }

    /**
     * Whether the Stop control owns the ending of the node runs that already exist (FR-CTL-003).
     *
     * `controls.stop()` aborts first and lists the rows after (D110), and a row is in the store the
     * moment `nodeRuns.create` is called — so every row this drive created before the abort is one
     * the control moves to STOPPED and announces itself (D111). Announcing it here as well would put
     * a second STOPPED frame on the socket for one node run. A shutdown has no control writing
     * anything, so there the drive announces its own rows.
     */
    function stoppedByControl(): boolean {
      return gate.abortCause() === 'stopped';
    }

    /**
     * A node run the abort caught before it started ends STOPPED, with the cancellation on its row,
     * and never FAILED (FR-ERR-007, TC-ERR-008).
     */
    async function stopUnstarted(nodeRun: NodeRun): Promise<void> {
      states.set(nodeRun.nodeId, 'STOPPED');
      if (stoppedByControl()) {
        // The Stop moves this row to STOPPED and announces it (D111). Writing the status here could
        // land before it lists the rows, and then nobody would announce it at all (D-063).
        await repository.nodeRuns.update(scope, nodeRun.id, { error: cancelledBeforeStart() });
        return;
      }
      await repository.nodeRuns.update(scope, nodeRun.id, {
        status: 'STOPPED',
        error: cancelledBeforeStart(),
        endedAt: now(),
      });
      await emitNodeState(run, nodeRun, 'STOPPED');
    }

    /**
     * Holds a node run that has not started while the run is paused, and says whether it may start
     * (FR-CTL-001, FR-CTL-002): `false` means the run was aborted meanwhile, and the node run has
     * been ended STOPPED. Covers every attempt — a first one dispatched just as the pause landed, and
     * a retry whose backoff ran out during it — because the dispatch loop's own check only covers
     * what it has not dispatched yet.
     *
     * A row born PAUSED that `resume` missed — created after it listed the PAUSED rows and before it
     * lifted the gate — goes back to READY here, so it still walks PAUSED → READY → RUNNING
     * (Arch §19.1). `resume` finishes writing before it lifts the gate, so reading now races nothing.
     */
    async function holdWhilePaused(nodeRun: NodeRun): Promise<boolean> {
      if (!(await gate.waitUntilDispatchable())) {
        await stopUnstarted(nodeRun);
        return false;
      }
      if (nodeRun.status !== 'PAUSED') return true;

      const stored = await repository.nodeRuns.get(scope, nodeRun.id);
      if (stored?.status === 'PAUSED') {
        await repository.nodeRuns.update(scope, nodeRun.id, { status: 'READY' });
        await emitNodeState(run, nodeRun, 'READY');
      }
      return true;
    }

    /**
     * Deliver a completed node's output along its outgoing edges (FR-EXE-005, FR-EXE-015).
     *
     * `only` names the edges to travel down, which is what a loop needs: while the loop is going
     * round a body node delivers *inward* only (§2.4), and the re-queue delivers along the loop edge
     * itself. Absent, it is every outgoing data edge — the ordinary case.
     */
    async function deliver(
      node: Node,
      parts: Part[],
      iteration: number,
      only?: readonly Edge[],
      /**
       * D309: a node that completes the same iteration again hands off a *fresh* envelope, which
       * replaces the one it sent before rather than joining it.
       */
      replace = false,
      /** D310: the HANDOFF this delivery is, so the edge envelope and the transfer name it. */
      teamEnvelopeId?: Id,
    ): Promise<void> {
      const outgoing =
        only ?? edges.filter((edge) => edge.from.nodeId === node.id && edge.kind === 'data');
      if (outgoing.length === 0) return;
      const targets = new Set(outgoing.map((edge) => edge.to.nodeId));

      for (const targetId of targets) {
        const target = nodeById.get(targetId);
        if (target === undefined) continue;
        // A node the controls handed a fixed set of inputs runs on exactly those (FR-ERR-003).
        if (plannedRuns.has(targetId)) continue;

        // Built before the list is read: another delivery may land while this one awaits.
        const built = await envelopeBetween(run, node, target, parts, iteration, { signal });
        const envelope = teamEnvelopeId === undefined ? built : { ...built, teamEnvelopeId };
        const kept = (envelopesFor.get(targetId) ?? []).filter(
          (earlier) => !replace || earlier.fromNodeId !== node.id,
        );
        envelopesFor.set(targetId, [...kept, envelope]);
      }

      for (const edge of outgoing) {
        if (replace && nodeById.get(edge.to.nodeId)?.kind === 'merge') {
          mergeArrivals.clear(edge.to.nodeId, new Set([node.id]));
        }
        // Recorded *before* the edge counts as delivered: `isMergeReady` reads `deliveredEdges`, so
        // a merge that became ready on this edge must already find its arrival in the log (§2.4).
        if (nodeById.get(edge.to.nodeId)?.kind === 'merge') {
          mergeArrivals.record(edge.to.nodeId, {
            edgeId: edge.id,
            portId: edge.to.portId,
            fromNodeId: node.id,
            parts,
          });
        }

        deliveredEdges.add(edge.id);
        await bus.emit({
          type: 'edge.transfer',
          workflowId: run.workflowId,
          runId: run.id,
          payload: {
            runId: run.id,
            edgeId: edge.id,
            fromNodeId: edge.from.nodeId,
            toNodeId: edge.to.nodeId,
            iteration,
            summary: transferSummary(parts),
            ...(teamEnvelopeId === undefined ? {} : { envelopeId: teamEnvelopeId }),
          },
        });
      }
    }

    /** A failed node takes everything that could only be reached through it (FR-ERR-006). */
    async function blockDownstream(node: Node): Promise<void> {
      for (const blockedId of downstreamOf(node.id, edges)) {
        if (states.get(blockedId) !== 'IDLE') continue;
        const blocked = nodeById.get(blockedId);
        if (blocked === undefined) continue;
        if (isReady(blocked, edges, deliveredEdges)) continue;

        states.set(blockedId, 'BLOCKED');
        const nodeRun: NodeRun = {
          id: nextId(),
          runId: run.id,
          nodeId: blockedId,
          iteration: 1,
          attempt: 1,
          status: 'BLOCKED',
          failureReason: 'BLOCKED',
          // FR-ERR-006: a BLOCKED node names what blocked it, so "Blocked by "Gatekeeper", which did
          // not finish." is on the row rather than only in the run's shape.
          error: upstreamFailedError(node.name, node.id).nodeError,
          inputEnvelopes: envelopesFor.get(blockedId) ?? [],
          usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          verdicts: [],
          toolCalls: [],
        };
        await repository.nodeRuns.create(scope, nodeRun);
        nodeRunByNode.set(blockedId, nodeRun);
        await emitNodeState(run, nodeRun, 'BLOCKED', 'BLOCKED');
      }
    }

    /**
     * Put the loop body back to the start of its next iteration (FR-PAR-003, §2.4, Arch §12.3).
     *
     * Everything *inside* the body is forgotten and everything from *outside* it is kept, which is
     * `planNextIteration`'s whole rule: iteration 2 of a Review→Fix loop is a Writer that still has
     * the original brief plus the reviewer's critique, never a Writer with no brief.
     */
    async function requeue(
      source: Node,
      output: Part[],
      loopEdge: Edge,
      decision: LoopContinue,
    ): Promise<void> {
      const plan = planNextIteration(decision, edges, nodes);

      for (const edgeId of plan.clearEdgeIds) deliveredEdges.delete(edgeId);
      // Scoped to the body: a branch feeding a merge from outside does not run again, so dropping
      // its arrival would leave an `all` merge waiting for something that never comes back.
      for (const mergeNodeId of plan.mergeNodeIds) mergeArrivals.clear(mergeNodeId, plan.body);

      for (const nodeId of plan.body) {
        envelopesFor.set(nodeId, retainedEnvelopes(envelopesFor.get(nodeId) ?? [], plan.body));
        iterations.set(nodeId, plan.iteration);
        states.set(nodeId, 'IDLE');
      }

      // Last, and after the reset: the critique travels back along the loop edge into the iteration
      // about to start, and `retainedEnvelopes` above would have thrown it away.
      await deliver(source, output, plan.iteration, [loopEdge]);
    }

    /**
     * What a node run spent: its own calls, plus — once, on the first of its runs recorded — what
     * summarising its inputs cost (F5). The summary was made for this node by its own model, so
     * FR-OBS-002's "totals are the sum of the node runs" has to count it here.
     */
    function spentBy(nodeRun: NodeRun, usage: Usage): Usage {
      const summarised = summaryUsage.take(run.id, nodeRun.nodeId);
      if (summarised === undefined) return usage;
      // D313: the turn's own provenance survives the summary's spend being added to it.
      const { source, costSource, cachedTokensIn } = usage;
      return {
        ...sumUsage([usage, summarised]),
        ...(source === undefined ? {} : { source }),
        ...(costSource === undefined ? {} : { costSource }),
        ...(cachedTokensIn === undefined ? {} : { cachedTokensIn }),
      };
    }

    /**
     * D313: the run's use against its token budget — input + output, cached input included. A
     * threshold crossed for the first time is said (`run.token_budget`); at the limit nothing new
     * starts and the run goes BLOCKED `BUDGET_EXCEEDED` (D305). Answers whether it is over.
     */
    async function checkBudget(): Promise<boolean> {
      if (domain === undefined) return false;
      const total = sumUsage(usages);
      const used = total.tokensIn + total.tokensOut;
      domain.noteUsed(used);
      const crossing = budgetCrossing(domain.budget(), used);
      domain.noteBudget(crossing.state);
      if (crossing.level !== undefined) {
        await bus.emit({
          type: 'run.token_budget',
          workflowId: run.workflowId,
          runId: run.id,
          payload: { runId: run.id, limit: crossing.state.limit, used, level: crossing.level },
        });
      }
      if (!isOverBudget(crossing.state, used)) return false;
      // Already held, or ending: nothing more to block.
      if (!gate.isPaused() && !domain.endRequested() && !signal.aborted) {
        await blockRun(
          'BUDGET_EXCEEDED',
          `${used.toLocaleString('en-US')} of ${(crossing.state.limit ?? 0).toLocaleString('en-US')} tokens used. No new turn starts until the budget is raised or removed, or the run is ended.`,
        );
      }
      return true;
    }

    /**
     * What the node run's context used and its memory ops (round 5, FR-RAG-007, FR-MEM-002), and
     * the envelopes it read when the executor placed what it read on them — a Retrieval node's hits
     * (R5 §2.4) — masked as the stored prompt is (BR-07), as the agent's context step stores them.
     */
    function roundFiveFields(
      outcome: NodeExecutionOutcome,
    ): Partial<Pick<NodeRun, 'sources' | 'droppedSources' | 'memoryOps' | 'inputEnvelopes'>> {
      return {
        ...(outcome.sources === undefined ? {} : { sources: outcome.sources }),
        ...(outcome.droppedSources === undefined ? {} : { droppedSources: outcome.droppedSources }),
        ...(outcome.memoryOps === undefined ? {} : { memoryOps: outcome.memoryOps }),
        ...(outcome.inputEnvelopes === undefined
          ? {}
          : { inputEnvelopes: maskedForStorage(outcome.inputEnvelopes) }),
      };
    }

    /**
     * Write what one attempt produced onto its own row and account for what it spent.
     *
     * Separate from `finish` because an attempt the engine is about to retry is a complete, recorded
     * attempt — FR-ERR-005's `retry-429` has two FAILED rows and a COMPLETED one — and yet it must
     * not deliver anything, must not block what is downstream of it and must not decide a loop.
     */
    async function recordAttempt(
      nodeRun: NodeRun,
      outcome: NodeExecutionOutcome,
      endedAt: string,
    ): Promise<void> {
      const usage = spentBy(nodeRun, outcome.usage);
      usages.push(usage);
      const startedAt = startedAtByNodeRun.get(nodeRun.id);

      await repository.nodeRuns.update(scope, nodeRun.id, {
        status: outcome.status,
        ...(outcome.failureReason === undefined ? {} : { failureReason: outcome.failureReason }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.modelUsed === undefined ? {} : { modelUsed: outcome.modelUsed }),
        ...(outcome.prompt === undefined ? {} : { prompt: outcome.prompt }),
        ...roundFiveFields(outcome),
        output: outcome.output,
        usage,
        endedAt,
        // F10: provider latency in the health metrics is read from this (FR-OBS-007).
        ...(startedAt === undefined
          ? {}
          : { durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) }),
      });

      // A Stop that landed meanwhile owns the run's totals: it wrote them, and the drive corrects
      // them once everything has unwound (D-052). A running sum announced now would follow its
      // `run.completed` (D-063).
      if (stoppedByControl()) return;

      // Totals are the running sum of the node runs, so the number a client sees mid-run is the
      // same arithmetic as the number stored at the end (TC-OBS-002).
      // D313: an agent's or model's turn says what it used, so Domain's totals are Track's.
      const node = nodeById.get(nodeRun.nodeId);
      const model = outcome.modelUsed;
      const providerType = model === undefined ? undefined : providerTypes.get(model.providerId);
      const turnModelId = model?.resolvedModelId ?? model?.modelId;
      const turn =
        node === undefined || (node.kind !== 'agent' && node.kind !== 'model')
          ? undefined
          : {
              nodeRunId: nodeRun.id,
              nodeId: nodeRun.nodeId,
              ...(providerType === undefined ? {} : { providerType }),
              ...(turnModelId === undefined ? {} : { modelId: turnModelId }),
              usage,
            };
      await bus.emit({
        type: 'usage.updated',
        workflowId: run.workflowId,
        runId: run.id,
        payload: {
          runId: run.id,
          totals: sumUsage(usages),
          ...(turn === undefined ? {} : { turn }),
        },
      });
      await checkBudget();
    }

    /**
     * D-063: a node run the Stop caught — its call returned, or its result was on its way, as the
     * Stop landed. The Stop owns its ending (D111): it moves the row to STOPPED, stamps it and
     * announces it, then emits `run.completed`. So only what the node spent, and the cancellation
     * behind it, are written here — never a status, which could put COMPLETED over the Stop's STOPPED
     * or land before the Stop lists the rows and leave the node unannounced — and nothing is
     * announced, which would follow `run.completed`. Nothing flows on from it either (D-052).
     */
    async function recordStopped(
      node: Node,
      nodeRun: NodeRun,
      outcome: NodeExecutionOutcome,
    ): Promise<void> {
      const usage = spentBy(nodeRun, outcome.usage);
      usages.push(usage);
      states.set(node.id, 'STOPPED');
      await repository.nodeRuns.update(scope, nodeRun.id, {
        error:
          outcome.status === 'STOPPED' && outcome.error !== undefined
            ? outcome.error
            : userCancelledError('The run was stopped before this node run was recorded.')
                .nodeError,
        usage,
        ...(outcome.modelUsed === undefined ? {} : { modelUsed: outcome.modelUsed }),
        ...(outcome.prompt === undefined ? {} : { prompt: outcome.prompt }),
        ...roundFiveFields(outcome),
      });
    }

    /** A failed node whose outcome carried no error of its own — said plainly rather than left blank. */
    const didNotFinish = (node: Node): NodeError => ({
      kind: 'workflow',
      code: 'node_failed',
      message: `"${node.name}" did not finish.`,
      retryable: false,
    });

    /**
     * D285: a goal-driven node's run, as two turns of its chat session — what it was asked (its
     * goal, or with none of its own, the text it was handed) and what it produced or why it failed.
     * The chat is where a node's results are read, so this is not optional bookkeeping; but it is
     * never allowed to fail the run it describes.
     */
    async function handTurnToChat(
      node: Node,
      outcome: NodeExecutionOutcome,
      /** Why it ended without a result; `undefined` means it produced `outcome.output`. */
      failure: NodeError | undefined,
    ): Promise<void> {
      if (deps.recordNodeTurn === undefined || !isGoalDriven(node)) return;

      const goal = goalOf(node);
      const handed = (envelopesFor.get(node.id) ?? [])
        .flatMap((envelope) => envelope.reads)
        .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n\n')
        .trim();
      const asked = goal !== '' ? goal : handed;

      try {
        await deps.recordNodeTurn({
          nodeId: node.id,
          runId: run.id,
          goal: asked === '' ? [] : [{ type: 'text', text: maskSecrets(asked) }],
          ...(failure === undefined ? { output: outcome.output } : { error: failure }),
          // The call's own usage; `spentBy` would take the summary ledger's share a second time.
          usage: outcome.usage,
          ...(outcome.modelUsed?.resolvedModelId === undefined
            ? {}
            : { modelId: outcome.modelUsed.resolvedModelId }),
        });
      } catch (error) {
        logger.warn(
          { subsystem: 'runs', runId: run.id, nodeId: node.id, err: error },
          'the node chat could not record this run',
        );
      }
    }

    /**
     * The turn's own abort fired — a human message cut it short, or the run was ended — and not the
     * run's (a Stop or a shutdown has its own path). Absent otherwise.
     */
    function turnCut(turn: TurnContext | undefined): TurnAbortReason | undefined {
      const abort = turn?.abort;
      if (abort === undefined || !abort.signal.aborted || signal.aborted) return undefined;
      const reason: unknown = abort.signal.reason;
      return isTurnAbortReason(reason) ? reason : undefined;
    }

    /** How long a node run took, start to end, when it started at all. */
    function durationOf(nodeRun: NodeRun, endedAt: string): number | undefined {
      const startedAt = startedAtByNodeRun.get(nodeRun.id);
      return startedAt === undefined
        ? undefined
        : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    }

    /**
     * D309, D323: a node that has finished a turn takes up the HANDOFF again — its successors that
     * had completed run again on the fresh envelope, the ones a failure of it had BLOCKED are
     * unblocked, and one still busy runs again once its turn is over.
     */
    function rearmSuccessors(node: Node): void {
      const direct = new Set(
        edges
          .filter((edge) => edge.kind === 'data' && edge.from.nodeId === node.id)
          .map((edge) => edge.to.nodeId),
      );
      for (const id of direct) {
        const state = states.get(id);
        if (state === 'COMPLETED' || state === 'BLOCKED') states.set(id, 'IDLE');
        else if (state === 'RUNNING' || state === 'READY' || state === 'WAITING') {
          staleSuccessors.add(id);
        }
      }
      for (const id of downstreamOf(node.id, edges)) {
        if (states.get(id) === 'BLOCKED') states.set(id, 'IDLE');
      }
    }

    /** D305: RUNNING → BLOCKED mid-run. The gate holds what has not started; resume lifts it. */
    async function blockRun(reason: BlockedReason, detail: string, nodeIds?: Id[]): Promise<void> {
      gate.pause();
      await repository.runs.update(scope, run.id, {
        status: 'BLOCKED',
        blockedReason: reason,
        allowedActions: allowedRunActions('BLOCKED', { blockedReason: reason, stayOpen }),
      });
      await bus.emit({
        type: 'run.blocked',
        workflowId: run.workflowId,
        runId: run.id,
        payload: { runId: run.id, reason, detail, ...(nodeIds === undefined ? {} : { nodeIds }) },
      });
    }

    /**
     * D310: a turn an envelope started that is not the node's own work — answering a QUERY, or any
     * envelope reaching a node the graph has not dispatched yet. It hands nothing on unless it says
     * so, and the node goes back to the state it was in.
     */
    function isSideTurn(node: Node, turn: TurnContext | undefined): boolean {
      if (turn?.trigger !== 'envelope') return false;
      const carried = turn.envelopes ?? [];
      return (
        stateBeforeTurn.get(node.id) === 'IDLE' ||
        (carried.length > 0 && carried.every((envelope) => envelope.kind === 'QUERY'))
      );
    }

    /** D310: the asker's next turn has begun, so the QUERY turn it was waiting on is over. */
    async function closeWaiting(nodeId: Id): Promise<void> {
      const row = waitingRows.get(nodeId);
      if (row === undefined) return;
      waitingRows.delete(nodeId);
      await repository.nodeRuns.update(scope, row.id, { status: 'COMPLETED' });
      await emitNodeState(run, row, 'COMPLETED');
    }

    /**
     * D310: what a finished turn sent its team. Every envelope — the blocks the agent wrote, or the
     * implicit HANDOFF of an answer that wrote none — is announced, goes through the Brain's router
     * and is forwarded or held. A QUERY or a FLAG holds the output back; so does a side turn.
     */
    async function sendEnvelopes(
      node: Node,
      nodeRun: NodeRun,
      outcome: NodeExecutionOutcome,
      outgoing: readonly Edge[],
      side: boolean,
    ): Promise<TurnRouting> {
      if (domain === undefined) return { waiting: false, handoff: 'now', edges: [...outgoing] };
      const explicit = outcome.teamEnvelopes ?? [];
      const kinds = new Set(explicit.map((envelope) => envelope.kind));
      const waiting = kinds.has('QUERY');
      const named = explicit.find((envelope) => envelope.kind === 'HANDOFF');
      const handsOn = !waiting && !kinds.has('FLAG') && (named !== undefined || !side);
      const body = envelopeBody(outcome.output);

      const sends: (JudgedEnvelope & { textSource: 'summary' | 'auto' })[] = explicit.map(
        (envelope) => ({ ...envelope, textSource: 'summary' }),
      );
      let along: Edge[] = [];
      if (handsOn) {
        // An explicit HANDOFF picks among the teammates it feeds; what cannot be named (an Output
        // node, a merge) is fed regardless.
        along =
          named === undefined
            ? [...outgoing]
            : outgoing.filter(
                (edge) => named.toNodeIds.includes(edge.to.nodeId) || !onRoster.has(edge.to.nodeId),
              );
        if (named === undefined && along.length > 0) {
          sends.push({
            kind: 'HANDOFF',
            toNodeIds: [...new Set(along.map((edge) => edge.to.nodeId))],
            summary: autoExcerpt(outcome.output),
            textSource: 'auto',
          });
        }
      }

      let handoff: TurnRouting['handoff'] = handsOn ? 'now' : 'none';
      let handoffId: Id | undefined;
      let guard: { nodeIds: Id[]; count: number } | undefined;
      for (const send of sends) {
        const envelopeId = nextId();
        const summary = send.summary.slice(0, ENVELOPE_SUMMARY_MAX);
        const inReplyTo = send.inReplyTo === undefined ? {} : { inReplyTo: send.inReplyTo };
        await bus.emit({
          type: 'envelope.sent',
          workflowId: run.workflowId,
          runId: run.id,
          payload: {
            runId: run.id,
            envelopeId,
            nodeRunId: nodeRun.id,
            kind: send.kind,
            fromNodeId: node.id,
            toNodeIds: send.toNodeIds,
            summary,
            textSource: send.textSource,
            ...inReplyTo,
            // FR-MM-004: no file refs in the log — the projection reads them off `node.output`.
            artifacts: [],
          },
        });
        if (send.kind === 'QUERY') {
          domain.openQueries.set(envelopeId, { from: node.id, to: send.toNodeIds });
        }
        if (send.kind === 'ANSWER' && send.inReplyTo !== undefined) {
          domain.openQueries.delete(send.inReplyTo);
        }
        countLoop(domain.loopCounts, send.kind, node.id, send.toNodeIds);
        const verdict = routeByBrain({
          mode: domain.config.routing,
          kind: send.kind,
          from: node.id,
          to: send.toNodeIds,
          counts: domain.loopCounts,
          limit: domain.config.loopGuardLimit,
        });
        await bus.emit({
          type: 'envelope.routed',
          workflowId: run.workflowId,
          runId: run.id,
          payload: {
            runId: run.id,
            envelopeId,
            decision: verdict.decision,
            by: 'brain',
            ...(verdict.decision === 'HELD' ? { reason: verdict.reason } : {}),
          },
        });
        domain.noteRouted(
          digestLine(
            labelOf,
            { kind: send.kind, from: node.id, to: send.toNodeIds, summary },
            verdict.decision,
          ),
        );
        if (send.kind === 'HANDOFF') handoffId = envelopeId;

        if (verdict.decision === 'FORWARDED') {
          if (send.kind !== 'HANDOFF') {
            domain.enqueueEnvelope(
              {
                envelopeId,
                kind: send.kind,
                fromNodeId: node.id,
                summary,
                body,
                at: now(),
                ...inReplyTo,
              },
              send.toNodeIds,
            );
          }
          continue;
        }
        domain.hold({
          envelopeId,
          kind: send.kind,
          fromNodeId: node.id,
          fromNodeRunId: nodeRun.id,
          toNodeIds: send.toNodeIds,
          summary,
          body,
          ...inReplyTo,
          output: outcome.output,
          iteration: nodeRun.iteration,
          reason: verdict.reason,
        });
        if (send.kind === 'HANDOFF') handoff = 'held';
        if (verdict.reason === 'LOOP_GUARD') guard ??= verdict.loopGuard;
      }

      if (guard !== undefined) {
        const [a = '', b = ''] = guard.nodeIds;
        await blockRun(
          'LOOP_GUARD',
          `${labelOf(a)} and ${labelOf(b)} have sent each other ${guard.count} QUERY and FLAG envelopes, over the limit of ${domain.config.loopGuardLimit}. Resume to let them carry on, or reject the held envelope first.`,
          guard.nodeIds,
        );
      }

      return {
        waiting,
        handoff,
        edges: along,
        ...(handoffId === undefined ? {} : { envelopeId: handoffId }),
      };
    }

    /**
     * D310: a turn that was handed a QUERY and ended without answering it — it failed — so the
     * asker would wait for ever. The Brain answers for it with a note, and the asker carries on.
     */
    async function noteUnanswered(
      node: Node,
      nodeRun: NodeRun,
      failure: NodeError | undefined,
      turn: TurnContext | undefined,
    ): Promise<void> {
      if (domain === undefined) return;
      for (const query of turn?.envelopes ?? []) {
        if (query.kind !== 'QUERY' || !domain.openQueries.has(query.envelopeId)) continue;
        domain.openQueries.delete(query.envelopeId);
        const envelopeId = nextId();
        const summary = maskSecrets(
          `${labelOf(node.id)} could not answer: ${failure?.message ?? 'its turn did not finish.'}`,
        ).slice(0, ENVELOPE_SUMMARY_MAX);
        await bus.emit({
          type: 'envelope.sent',
          workflowId: run.workflowId,
          runId: run.id,
          payload: {
            runId: run.id,
            envelopeId,
            nodeRunId: nodeRun.id,
            kind: 'ANSWER',
            fromNodeId: node.id,
            toNodeIds: [query.fromNodeId],
            summary,
            textSource: 'auto',
            inReplyTo: query.envelopeId,
            artifacts: [],
          },
        });
        await bus.emit({
          type: 'envelope.routed',
          workflowId: run.workflowId,
          runId: run.id,
          payload: {
            runId: run.id,
            envelopeId,
            decision: 'FORWARDED',
            by: 'brain',
            reason: 'the addressee could not answer',
          },
        });
        domain.noteRouted(
          digestLine(
            labelOf,
            { kind: 'ANSWER', from: node.id, to: [query.fromNodeId], summary },
            'FORWARDED',
          ),
        );
        domain.enqueueEnvelope(
          {
            envelopeId,
            kind: 'ANSWER',
            fromNodeId: node.id,
            summary,
            body: '',
            inReplyTo: query.envelopeId,
            at: now(),
          },
          [query.fromNodeId],
        );
      }
    }

    /** D310: carry out what the human decided about a held envelope (or a resume released). */
    async function applyDecision(decision: EnvelopeDecision): Promise<void> {
      if (domain === undefined) return;
      const { held } = decision;
      const kind = decision.edit?.kind ?? held.kind;
      const toNodeIds = decision.edit?.toNodeIds ?? held.toNodeIds;
      const summary = decision.edit?.summary ?? held.summary;
      domain.noteRouted(
        digestLine(
          labelOf,
          { kind, from: held.fromNodeId, to: toNodeIds, summary },
          decision.decision,
        ),
      );
      if (decision.decision === 'REJECTED') return;

      if (kind !== 'HANDOFF') {
        if (kind === 'QUERY') {
          domain.openQueries.set(held.envelopeId, { from: held.fromNodeId, to: toNodeIds });
        }
        domain.enqueueEnvelope(
          {
            envelopeId: held.envelopeId,
            kind,
            fromNodeId: held.fromNodeId,
            summary,
            body: held.body,
            at: now(),
            ...(held.inReplyTo === undefined ? {} : { inReplyTo: held.inReplyTo }),
          },
          toNodeIds,
        );
        return;
      }

      const from = nodeById.get(held.fromNodeId);
      if (from === undefined) return;
      const output =
        held.output ?? (await repository.nodeRuns.get(scope, held.fromNodeRunId))?.output ?? [];
      const along = dataEdgesFrom(from.id).filter(
        (edge) => toNodeIds.includes(edge.to.nodeId) || !onRoster.has(edge.to.nodeId),
      );
      await deliver(from, output, held.iteration, along, true, held.envelopeId);
      rearmSuccessors(from);
    }

    async function finish(
      node: Node,
      nodeRun: NodeRun,
      outcome: NodeExecutionOutcome,
      endedAt: string = now(),
      turn?: TurnContext,
    ): Promise<void> {
      if (stoppedByControl()) {
        await recordStopped(node, nodeRun, outcome);
        return;
      }

      const iteration = nodeRun.iteration;

      /*
       * D309, D323: a turn a human message cut short, or one an End stopped. What it wrote stays on
       * its row (and, for an interrupt, in the log), but nothing flows on from it — no handoff, no
       * loop decision, nothing blocked downstream — and no chat turn is written for it.
       */
      const cut = turnCut(turn);
      if (cut !== undefined) {
        await recordAttempt(nodeRun, { ...outcome, output: outcome.partialOutput ?? [] }, endedAt);
        if (cut.domain === 'interrupt') {
          await bus.emit({
            type: 'node.interrupted',
            workflowId: run.workflowId,
            runId: run.id,
            payload: {
              runId: run.id,
              nodeRunId: nodeRun.id,
              nodeId: node.id,
              messageId: cut.messageId,
              partialOutput: outcome.partialOutput ?? [],
            },
          });
          states.set(node.id, 'STOPPED');
        } else {
          // Ended: the graph is read as it stood before this turn began.
          states.set(node.id, stateBeforeTurn.get(node.id) ?? 'STOPPED');
        }
        const took = durationOf(nodeRun, endedAt);
        await emitNodeState(
          run,
          nodeRun,
          'STOPPED',
          undefined,
          took === undefined ? {} : { durationMs: took },
        );
        return;
      }

      await recordAttempt(nodeRun, outcome, endedAt);

      /*
       * D-063: recorded a moment before a Stop landed. The node did finish first, so the Stop left
       * its row alone and its ending stands — announced now, ahead of the Stop's `run.completed` —
       * but nothing flows on from it: no delivery, no loop decision, no budget check (D-052).
       */
      if (stoppedByControl()) {
        states.set(node.id, outcome.status);
        await emitNodeState(run, nodeRun, outcome.status, outcome.failureReason);
        return;
      }

      // The cost point, *after* the call: a model that answered longer than its projection, or a cap
      // lowered mid-run (§2.3). The node keeps its result; the run stops dispatching.
      if (deps.budgets !== undefined) {
        const actual = await deps.budgets.afterNode({
          target: targetFor(node, nodeRun),
          projectId: run.projectId,
          totals: sumUsage(usages),
        });
        if (actual.halt !== undefined) budgetHalt ??= actual.halt;
      }

      /*
       * What the node ends as. The loop block below can change it — a stop with `onMax: 'fail'`
       * turns a COMPLETED loop source into FAILED (FR-PAR-006) — so the state is announced *after*
       * the loop has decided, never before. Announcing COMPLETED first and correcting it a moment
       * later would put a green node on the Canvas that the next frame paints red.
       */
      let status = outcome.status;
      let failureReason = outcome.failureReason;
      let failure = outcome.error;
      let requeued = false;
      /** D310: a turn-taking node in a run with Domain routes what it sends through the Brain. */
      const teamTurn = domain !== undefined && onRoster.has(node.id);
      const side = teamTurn && isSideTurn(node, turn);
      let routing: TurnRouting | undefined;

      if (outcome.status === 'COMPLETED') {
        if (node.kind === 'output') finalOutput[node.id] = outcome.output;

        const loopEdgeOfNode = loops.loopFor(node.id);
        const body = loopEdgeOfNode === undefined ? undefined : loops.body(loopEdgeOfNode.id);
        // Every body node's last output is remembered: `repeated_output` counts them (FR-GRD-009)
        // and the outward deliveries held back while the loop ran are flushed from it (§2.4).
        if (body !== undefined) loops.remember(node.id, outcome.output);

        /*
         * D309: a turn a message or an envelope started, or a node completing an iteration it had
         * already completed, hands off a fresh envelope — it replaces the earlier one, and what it
         * feeds runs again on it. Loop decisions belong to the graph's own dispatches only.
         */
        const triggered = (turn?.trigger ?? 'dispatch') !== 'dispatch';
        const again = completedIterations.has(attemptKey(node.id, iteration));
        completedIterations.add(attemptKey(node.id, iteration));
        const fresh = triggered || again;

        const { inside } = splitOutgoing(node.id, edges, body);
        if (teamTurn) {
          routing = await sendEnvelopes(node, nodeRun, outcome, inside, side);
          if (routing.waiting) {
            // D310: the asker's node run stays WAITING until the ANSWER starts its next turn.
            await repository.nodeRuns.update(scope, nodeRun.id, { status: 'WAITING' });
            waitingRows.set(node.id, nodeRun);
            states.set(node.id, 'WAITING');
            const took = durationOf(nodeRun, endedAt);
            await emitNodeState(
              run,
              nodeRun,
              'WAITING',
              undefined,
              took === undefined ? {} : { durationMs: took },
            );
            return;
          }
        }
        if (routing === undefined || routing.handoff === 'now') {
          await deliver(
            node,
            outcome.output,
            iteration,
            routing?.edges ?? inside,
            fresh,
            routing?.envelopeId,
          );
          if (fresh) rearmSuccessors(node);
        }

        /* Every loop this node is the source of decides now (FR-PAR-003..006, FR-GRD-009). */
        const heldBack = routing !== undefined && routing.handoff === 'none';
        for (const loopEdge of triggered || heldBack ? [] : loops.loopEdgesFrom(node.id)) {
          const decision = decideLoop({
            edge: loopEdge,
            edges,
            iteration,
            output: outcome.output,
            repeats: loops.repeats(),
            nameOf: (id) => nodeById.get(id)?.name ?? id,
            ...loopPointParams(node.id),
          });

          await bus.emit({
            type: 'loop.iteration',
            workflowId: run.workflowId,
            runId: run.id,
            payload: {
              runId: run.id,
              edgeId: loopEdge.id,
              targetNodeId: decision.targetNodeId,
              iteration: decision.iteration,
              ...(decision.kind === 'stop' ? { stop: decision.reason } : {}),
            },
          });

          if (decision.kind === 'continue') {
            await requeue(node, outcome.output, loopEdge, decision);
            requeued = true;
            continue;
          }

          // §2.4: the reason goes on the last iteration's node run of the loop source.
          await repository.nodeRuns.update(scope, nodeRun.id, { loopStop: decision.reason });

          if (decision.after === 'fail') {
            const loopFailed = loopFailure(decision);
            status = 'FAILED';
            failureReason = loopFailed.failureReason;
            failure = loopFailed.error;
            await repository.nodeRuns.update(scope, nodeRun.id, {
              status: 'FAILED',
              failureReason: loopFailed.failureReason,
              error: loopFailed.error,
            });
            continue;
          }

          // onMax `continue`, or the exit condition: the body's outward deliveries, held back for
          // exactly this moment, go out now — with the *last* iteration's output (FR-PAR-006).
          for (const held of loops.held(loopEdge.id, edges)) {
            const from = nodeById.get(held.nodeId);
            if (from === undefined) continue;
            await deliver(from, held.parts, iterations.get(held.nodeId) ?? iteration, held.edges);
          }
        }
      }

      /** D310: a side turn that handed nothing on leaves the node as it found it, whatever happened. */
      const sideEnded = side && (routing === undefined || routing.handoff === 'none');

      // D285: the node's chat session hears how it ended before anyone is told the state — a
      // result, or its own failure (an `invalid_config` one ends it BLOCKED, Arch §28).
      if (sideEnded) {
        // A side turn is a word with a teammate, not the node's own work.
      } else if (status === 'COMPLETED') {
        await handTurnToChat(node, outcome, undefined);
      } else if (status === 'FAILED' || status === 'BLOCKED') {
        await handTurnToChat(node, outcome, failure ?? didNotFinish(node));
      }

      // The requeue has already put the whole body back to IDLE at the next iteration, so only the
      // scheduler's own bookkeeping is conditional; the frame names this node run, which really did
      // finish, so the inspector still sees the iteration close.
      if (!requeued) {
        states.set(node.id, sideEnded ? (stateBeforeTurn.get(node.id) ?? 'IDLE') : status);
      }
      // A node run the Stop cut short was announced STOPPED by the control that stopped it; a second
      // STOPPED frame for it would be one node run ending twice (FR-CTL-003).
      if (!(status === 'STOPPED' && stoppedByControl())) {
        const took = durationOf(nodeRun, endedAt);
        await emitNodeState(
          run,
          nodeRun,
          status,
          failureReason,
          took === undefined ? {} : { durationMs: took },
        );
      }

      // D310: an asker whose QUERY this turn was handed is not left waiting on a turn that failed.
      if (teamTurn && (status === 'FAILED' || status === 'BLOCKED') && !signal.aborted) {
        await noteUnanswered(node, nodeRun, failure, turn);
      }

      // BLOCKED means "an upstream failed" (FR-ERR-006), and a stop is not a failure (FR-ERR-007):
      // once the run is aborted nothing more is blocked — nor written after its `run.completed`.
      if (status !== 'COMPLETED' && !requeued && !signal.aborted && !sideEnded) {
        await blockDownstream(node);
      }

      // D309: handed a fresh envelope while it was busy, it runs again on it now.
      if (status === 'COMPLETED' && !requeued && staleSuccessors.delete(node.id)) {
        states.set(node.id, 'IDLE');
      }
    }

    /** A wait the abort can cut short — a stop must not sit out a retry backoff (FR-CTL-003). */
    function backoff(delayMs: number): Promise<void> {
      if (delayMs <= 0 || signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }

    /**
     * One node, through as many attempts as FR-ERR-005 allows it (§2.1, Arch §28, D105).
     *
     * `provider` and `network` failures come back with the exponential backoff; `agent` gets the one
     * contract repair, which re-sends the same prompt with the validation reason appended; `auth`,
     * `invalid_config`, `workflow`, `guardrail` and `user_cancelled` never come back at all. Each
     * attempt is its own node run at `attempt + 1`, so the history shows what was tried.
     *
     * `execution.retries` is read off the **snapshot** node, never the live workflow (D82).
     */
    async function dispatch(
      node: Node,
      iteration: number,
      trigger: TurnTriggerKind = 'dispatch',
    ): Promise<void> {
      // Which node run this dispatch is working on, so a throw can be pinned on the right row: a
      // row from an earlier iteration of the same node must not be the one that fails.
      nodeRunByNode.delete(node.id);
      try {
        await runNode(node, iteration, trigger);
      } catch (error) {
        await failUnfinishable(node, nodeRunByNode.get(node.id), error);
      }
    }

    /**
     * FR-EXE-011, FR-ERR-006: an error the engine did not expect while dispatching or finishing a
     * node — a write the store refused, say. Uncaught, it rejected the dispatch loop's race, and the
     * run was left RUNNING with its other in-flight nodes orphaned and no `run.completed`. Instead the
     * node ends FAILED with an engine error and takes its downstream with it, exactly as a node that
     * failed on its own would, and the run carries on to its end. Best effort throughout: the store
     * that just failed may fail again, and the run's end must not depend on it.
     */
    async function failUnfinishable(
      node: Node,
      nodeRun: NodeRun | undefined,
      error: unknown,
    ): Promise<void> {
      logger.error(
        { subsystem: 'runs', runId: run.id, nodeId: node.id, err: error },
        'could not finish a node run',
      );

      // A stop or a shutdown already decides how this node ends (FR-CTL-003, FR-ERR-007).
      if (signal.aborted) {
        states.set(node.id, 'STOPPED');
        return;
      }
      states.set(node.id, 'FAILED');

      if (nodeRun !== undefined) {
        try {
          const nodeError = engineFailure();
          await repository.nodeRuns.update(scope, nodeRun.id, {
            status: 'FAILED',
            failureReason: 'RUN_FAILED',
            error: nodeError,
            endedAt: now(),
          });
          await bus.emit({
            type: 'node.error',
            workflowId: run.workflowId,
            runId: run.id,
            payload: {
              runId: run.id,
              nodeRunId: nodeRun.id,
              nodeId: node.id,
              error: nodeError,
              failureReason: 'RUN_FAILED',
            },
          });
          await emitNodeState(run, nodeRun, 'FAILED', 'RUN_FAILED');
        } catch (second) {
          logger.error(
            { subsystem: 'runs', runId: run.id, nodeId: node.id, err: second },
            'could not record a node run as failed',
          );
        }
      }

      try {
        await blockDownstream(node);
      } catch (second) {
        logger.error(
          { subsystem: 'runs', runId: run.id, nodeId: node.id, err: second },
          'could not block what is downstream of a failed node',
        );
      }
    }

    /**
     * Arch §28: an auth failure (401/403) leaves the node FAILED *and* its provider AUTH_FAILED, so
     * the providers screen and the next pre-flight see the refused key (FR-ERR-001, Arch §19.3). The
     * provider is the one the call went to; the provider service stores and announces the state.
     * Best effort: the node's own failure is what the run is about, and it is recorded either way.
     */
    async function markAuthFailed(node: Node, outcome: NodeExecutionOutcome): Promise<void> {
      const error = outcome.error;
      if (deps.recordProviderStatus === undefined || error === undefined) return;
      const providerId =
        error.providerId ??
        outcome.modelUsed?.providerId ??
        (node.kind === 'agent' || node.kind === 'model' ? node.config.providerId : undefined);
      if (providerId === undefined) return;

      try {
        await deps.recordProviderStatus(providerId, {
          status: 'AUTH_FAILED',
          message: error.message,
        });
      } catch (failure) {
        logger.warn(
          { subsystem: 'runs', runId: run.id, providerId, err: failure },
          'could not mark the provider AUTH_FAILED',
        );
      }
    }

    /**
     * PG-5.1: one writing node step inside its own checkpoint — begun before the step's first
     * attempt, finished once its last attempt ended (completed, failed, stopped). A checkpoint that
     * cannot begin is stored `failed` and shown in Changes; the step goes on, as the run's own
     * check already passed at start (D361) or the person chose to run without undo.
     */
    async function recordedStep(node: Node, step: () => Promise<void>): Promise<void> {
      const recording = await beginStepCheckpoint(run, node.id);
      try {
        await step();
      } finally {
        await recording?.finish().catch(() => undefined);
      }
    }

    async function runNode(
      node: Node,
      iteration: number,
      trigger: TurnTriggerKind = 'dispatch',
    ): Promise<void> {
      // `states` is the scheduler's own bookkeeping: dispatched, so never picked up twice. The node
      // run itself stays READY until it holds its provider slot (D66, FR-PRV-009).
      states.set(node.id, 'RUNNING');

      /*
       * D309: an agent's or model's turn has an abort of its own beside the run's, so a human message
       * can cut this turn short without touching anything else the run is doing.
       */
      const turnAbort =
        domain !== undefined && (node.kind === 'agent' || node.kind === 'model')
          ? domain.beginTurn(node.id)
          : undefined;
      const turnSignal =
        turnAbort === undefined ? signal : AbortSignal.any([signal, turnAbort.signal]);
      /** The human messages this turn has delivered, across all of its attempts. */
      const carried: QueuedMessage[] = [];
      /** D310: the envelopes this turn has delivered, likewise. */
      const carriedEnvelopes: QueuedEnvelope[] = [];
      const turn: TurnContext = {
        trigger,
        envelopes: carriedEnvelopes,
        ...(turnAbort === undefined ? {} : { abort: turnAbort }),
      };
      let lastNodeRunId: Id | undefined;

      /** What waits for this node that this turn has not delivered yet (D309, D326). */
      const freshMessages = (): QueuedMessage[] => {
        if (turnAbort === undefined || domain === undefined) return [];
        const seen = new Set(carried.map((message) => message.messageId));
        return domain.pending(node.id).filter((message) => !seen.has(message.messageId));
      };
      /** What the router forwarded to this node that this turn has not delivered yet (D310). */
      const freshEnvelopes = (): QueuedEnvelope[] => {
        if (turnAbort === undefined || domain === undefined) return [];
        const seen = new Set(carriedEnvelopes.map((envelope) => envelope.envelopeId));
        return domain
          .pendingEnvelopes(node.id)
          .filter((envelope) => !seen.has(envelope.envelopeId));
      };
      /** Why the attempt starts: absent for a plain dispatch that carries no message. */
      const triggerFor = (
        incoming: readonly QueuedMessage[],
        incomingEnvelopes: readonly QueuedEnvelope[],
      ): TurnTrigger | undefined => {
        const ids = [...carried, ...incoming].map((message) => message.messageId);
        const envelopeIds = [...carriedEnvelopes, ...incomingEnvelopes].map(
          (envelope) => envelope.envelopeId,
        );
        if (trigger === 'dispatch' && ids.length === 0 && envelopeIds.length === 0)
          return undefined;
        return {
          kind: trigger,
          ...(ids.length === 0 ? {} : { messageIds: ids }),
          ...(envelopeIds.length === 0 ? {} : { envelopeIds }),
        };
      };
      /**
       * D311: the run's goal, the team, the human's words to this node, what its teammates sent it
       * and — for the Brain — the digest of what was routed. An agent or model only.
       */
      const teamFor = (
        messages: readonly QueuedMessage[],
        envelopes: readonly QueuedEnvelope[],
      ): Pick<ExecuteNodeInput, 'team'> => {
        if (node.kind !== 'agent' && node.kind !== 'model') return {};
        const lines = roster.map((entry) => ({
          handle: entry.handle,
          name: entry.name,
          brain: entry.brain,
          you: entry.nodeId === node.id,
        }));
        const digest = domain !== undefined && node.id === brainId ? domain.digest() : [];
        const team: TeamPromptInput = {
          ...(run.goal === undefined ? {} : { goal: run.goal }),
          ...(lines.length < 2 ? {} : { roster: lines }),
          ...(messages.length === 0
            ? {}
            : { humanInstructions: messages.map((message) => message.text) }),
          ...(envelopes.length === 0
            ? {}
            : {
                teamMessages: envelopes.map((envelope) => ({
                  kind: envelope.kind,
                  envelopeId: envelope.envelopeId,
                  fromHandle:
                    roster.find((entry) => entry.nodeId === envelope.fromNodeId)?.handle ?? 'node',
                  summary: envelope.summary,
                  ...(envelope.body === '' ? {} : { body: envelope.body }),
                })),
              }),
          ...(digest.length === 0 ? {} : { digest }),
        };
        return Object.keys(team).length === 0 ? {} : { team };
      };
      /** D310: how this turn's envelope blocks are judged — the QUERYs it was handed it must answer. */
      const rulesFor = (
        envelopes: readonly QueuedEnvelope[],
      ): Pick<ExecuteNodeInput, 'teamEnvelopes'> => {
        if (domain === undefined || !onRoster.has(node.id)) return {};
        const mustAnswer = envelopes
          .filter(
            (envelope) => envelope.kind === 'QUERY' && domain.openQueries.has(envelope.envelopeId),
          )
          .map((envelope) => envelope.envelopeId);
        const successors = new Set(dataEdgesFrom(node.id).map((edge) => edge.to.nodeId));
        return {
          teamEnvelopes: {
            judge: (blocks) =>
              judgeEnvelopeBlocks(blocks, {
                roster,
                fromNodeId: node.id,
                successors,
                openQueries: domain.openQueries,
                mustAnswer,
              }),
          },
        };
      };

      try {
        await (writers.has(node.id)
          ? writeTurns.run(() => recordedStep(node, attempts))
          : attempts());
      } finally {
        if (turnAbort !== undefined) domain?.endTurn(node.id, turnAbort);
        // DONE when the turn ended; cut short, the messages wait for the next turn (D309).
        if (domain !== undefined && carried.length > 0 && lastNodeRunId !== undefined) {
          await domain.turnEnded(node.id, lastNodeRunId, carried, turnCut(turn) !== undefined);
        }
        // D310: an interrupted turn never answered what it was handed; the next one gets it.
        if (domain !== undefined && turnCut(turn)?.domain === 'interrupt') {
          domain.returnEnvelopes(node.id, carriedEnvelopes);
        }
      }

      async function attempts(): Promise<void> {
        const maxRetries =
          node.kind === 'agent' || node.kind === 'model' ? node.config.execution.retries : 0;

        let attempt = plannedRuns.get(node.id)?.attempt ?? nextAttemptFor(node.id, iteration);
        let contractRepairs = 0;
        let repairReason: string | undefined;

        await resolvePolicy(node);

        // The row a control already created and already answered the client with, used once. A second
        // row here would leave the client holding the id of a node run that never ran.
        const planned = plannedRuns.get(node.id);
        plannedRuns.delete(node.id);
        // D310: the asker's next turn ends the QUERY turn it was waiting on — unless this turn is
        // only a word with a teammate, and the asker still waits.
        if (!isSideTurn(node, turn)) await closeWaiting(node.id);
        let incoming = freshMessages();
        let incomingEnvelopes = freshEnvelopes();
        let nodeRun =
          planned ??
          (await beginNodeRun(node, iteration, attempt, triggerFor(incoming, incomingEnvelopes)));
        lastNodeRunId = nodeRun.id;
        if (planned !== undefined) {
          nodeRunByNode.set(node.id, planned);
          await emitNodeState(run, planned, 'READY');
        }
        if (nodeRun.status === 'STOPPED') {
          states.set(node.id, 'STOPPED');
          return;
        }

        for (;;) {
          if (!(await holdWhilePaused(nodeRun))) return;

          /*
           * The cost point, *before* the call (§2.3, FR-GRD-008): `totals + maxTokens × price` would
           * cross a cap, so the run halts before spending the money — which is the only version of a
           * budget that is actually a budget. The node run exists but never starts, so it ends STOPPED
           * rather than FAILED: nothing about it went wrong (BR-03, FR-ERR-007).
           */
          if (deps.budgets !== undefined) {
            const projected = await deps.budgets.beforeDispatch({
              target: targetFor(node, nodeRun),
              projectId: run.projectId,
              totals: sumUsage(usages),
              node,
              ...pricingFor(node),
            });

            if (projected.halt !== undefined) {
              budgetHalt ??= projected.halt;
              const at = now();
              await repository.nodeRuns.update(scope, nodeRun.id, {
                status: 'STOPPED',
                endedAt: at,
              });
              states.set(node.id, 'STOPPED');
              await emitNodeState(run, nodeRun, 'STOPPED');
              return;
            }
          }

          let running = false;
          /** When an agent's provider call ended, if it made one; else the node ends at finish. */
          let endedAt: string | undefined;
          const markRunning = async (): Promise<void> => {
            // Aborted: the node is not starting, and RUNNING written now could land over the STOPPED
            // the Stop already wrote (D111, D-063).
            if (running || signal.aborted) return;
            running = true;
            const startedAt = now();
            startedAtByNodeRun.set(nodeRun.id, startedAt);
            await repository.nodeRuns.update(scope, nodeRun.id, { status: 'RUNNING', startedAt });
            await emitNodeState(
              run,
              nodeRun,
              'RUNNING',
              undefined,
              nodeRun.trigger === undefined ? {} : { trigger: nodeRun.trigger },
            );
            // D309: the messages in this attempt's prompt are DELIVERED the moment it starts.
            if (domain !== undefined && incoming.length > 0) {
              const delivering = incoming;
              incoming = [];
              carried.push(...delivering);
              await domain.delivered(node.id, nodeRun.id, delivering);
            }
            if (domain !== undefined && incomingEnvelopes.length > 0) {
              const delivering = incomingEnvelopes;
              incomingEnvelopes = [];
              carriedEnvelopes.push(...delivering);
              domain.envelopesDelivered(
                node.id,
                delivering.map((envelope) => envelope.envelopeId),
              );
            }
          };
          const messagesForPrompt = [...carried, ...incoming];
          const envelopesForPrompt = [...carriedEnvelopes, ...incomingEnvelopes];
          turnSignals.set(nodeRun.id, turnSignal);

          const outcome =
            node.kind === 'merge'
              ? await (async (): Promise<NodeExecutionOutcome> => {
                  // A merge calls no provider and costs nothing, so it starts the instant it is
                  // dispatched; its output is a function of what arrived (FR-PAR-002).
                  await markRunning();
                  // Aborted meanwhile: nothing is merged or announced (D-063).
                  if (signal.aborted) {
                    return {
                      status: 'STOPPED',
                      output: [],
                      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
                      error: cancelledBeforeStart(),
                    };
                  }
                  return executeMergeNode(
                    {
                      runId: run.id,
                      workflowId: run.workflowId,
                      nodeRunId: nodeRun.id,
                      node,
                      edges,
                      arrivals: mergeArrivals.arrivals(node.id),
                    },
                    { bus },
                  );
                })()
              : await executor.execute({
                  runId: run.id,
                  workflowId: run.workflowId,
                  nodeRunId: nodeRun.id,
                  node,
                  envelopes: envelopesFor.get(node.id) ?? [],
                  iteration,
                  attempt,
                  runInputs: run.inputs,
                  signal: turnSignal,
                  gate,
                  onStarted: markRunning,
                  onEnded: () => {
                    endedAt = now();
                  },
                  ...guardrailsFor(node, nodeRun),
                  ...contextFor(node, nodeRun),
                  ...(repairReason === undefined ? {} : { repairReason }),
                  ...teamFor(messagesForPrompt, envelopesForPrompt),
                  ...rulesFor(envelopesForPrompt),
                  ...replayFor(run.id, node, iteration),
                });

          // A node that failed before it got a slot (no route, say) still passes through RUNNING, so
          // every node run follows Arch §19.1: READY → RUNNING → a terminal state. One a stop caught
          // before it started is the exception: it never ran, so it goes READY → STOPPED (D111).
          if (outcome.status !== 'STOPPED') await markRunning();

          if (outcome.error?.kind === 'auth') await markAuthFailed(node, outcome);

          if (outcome.status === 'FAILED' && outcome.error !== undefined && !signal.aborted) {
            const decision = autoRetryDecision({
              error: outcome.error,
              attempt,
              maxRetries,
              contractRepairs,
            });

            if (decision.retry) {
              // The attempt that failed is a recorded attempt: its row is FAILED and its usage counts,
              // it simply does not block anything or end the node (FR-ERR-003, FR-ERR-005).
              await recordAttempt(nodeRun, outcome, endedAt ?? now());
              await emitNodeState(run, nodeRun, 'FAILED', outcome.failureReason);

              attempt = decision.nextAttempt;
              if (decision.repairPrompt) {
                contractRepairs += 1;
                repairReason = outcome.error.message;
              }

              /*
               * The next attempt exists, READY, *before* the wait (FR-ERR-005). The engine has already
               * decided to try again, so the node is not finished — and a Stop during the backoff then
               * finds a READY row to end STOPPED (D111), leaving the FAILED attempt as history rather
               * than as the node's last word. A stopped run counts no failure (FR-ERR-007, TC-ERR-008).
               */
              // D309, D326: a message that arrived meanwhile — `@all` included — rides this retry.
              incoming = freshMessages();
              incomingEnvelopes = freshEnvelopes();
              nodeRun = await beginNodeRun(
                node,
                iteration,
                attempt,
                triggerFor(incoming, incomingEnvelopes),
              );
              lastNodeRunId = nodeRun.id;
              if (nodeRun.status === 'STOPPED') {
                states.set(node.id, 'STOPPED');
                return;
              }

              // Cut short by a stop; a pause is `holdWhilePaused`'s, at the top of the next attempt.
              await backoff(decision.delayMs);
              continue;
            }
          }

          await finish(node, nodeRun, outcome, endedAt, turn);
          return;
        }
      }
    }

    /*
     * A drive that re-opens a run someone already recorded: a retry, a re-run, or a run that starts
     * from a node (FR-CTL-005, FR-ERR-003, FR-ERR-004, FR-EXE-013).
     *
     * Two things have to be true afterwards. The planned nodes must be dispatchable — IDLE, with the
     * inputs their rows carry — and everything else must look exactly as it did when the run
     * stopped, so a re-run of one node does not restart the graph and does not leave the run HALTED
     * because an Output node it never touched is not COMPLETED in this process's memory.
     */
    if (seed !== undefined) {
      const forced = new Set<Id>(seed.nodeRuns.map((row) => row.nodeId));
      if (seed.withDownstream) {
        for (const nodeId of [...forced]) {
          for (const reached of downstreamOf(nodeId, edges)) forced.add(reached);
        }
      }

      for (const row of seed.nodeRuns) {
        plannedRuns.set(row.nodeId, row);
        // As delivered, not as read (13b fix I1): the context step builds the context afresh.
        envelopesFor.set(row.nodeId, asDelivered(row.inputEnvelopes, nodes));
        iterations.set(row.nodeId, row.iteration);
      }

      const rows = await repository.nodeRuns.listByRun(scope, run.id);
      // A further turn of any node takes the next attempt after every one already recorded (D95).
      for (const row of rows) {
        const key = attemptKey(row.nodeId, row.iteration);
        lastAttempt.set(key, Math.max(lastAttempt.get(key) ?? 0, row.attempt));
        // A node this drive re-runs is not "completing an iteration again" (D309): its new turn is
        // the control's, and only what `withDownstream` forces runs after it (FR-CTL-005).
        if (row.status === 'COMPLETED' && !plannedRuns.has(row.nodeId)) {
          completedIterations.add(key);
        }
      }
      const recorded = latestByNode(rows);

      for (const [nodeId, row] of recorded) {
        const node = nodeById.get(nodeId);
        if (node === undefined) continue;

        if (forced.has(nodeId)) {
          // Runs again. A forced node with no row of its own is fed by whatever re-runs above it.
          states.set(nodeId, 'IDLE');
          if (!plannedRuns.has(nodeId)) {
            iterations.set(nodeId, row.iteration);
            envelopesFor.set(nodeId, []);
          }
          continue;
        }

        states.set(nodeId, row.status);
        iterations.set(nodeId, row.iteration);
        if (row.status !== 'COMPLETED') continue;

        if (node.kind === 'output' && row.output !== undefined) finalOutput[nodeId] = row.output;

        // Its output crossed its edges in the drive that recorded it: the readiness bookkeeping is
        // rebuilt, the events are not — the transfer is already on the log, and emitting it again
        // would invent a second history for one delivery (BR-04).
        const outgoing = edges.filter(
          (edge) => edge.kind === 'data' && edge.from.nodeId === nodeId,
        );
        for (const edge of outgoing) {
          const target = nodeById.get(edge.to.nodeId);
          if (target === undefined) continue;
          if (target.kind === 'merge' && !plannedRuns.has(target.id)) {
            mergeArrivals.record(target.id, {
              edgeId: edge.id,
              portId: edge.to.portId,
              fromNodeId: nodeId,
              parts: row.output ?? [],
            });
          }
          deliveredEdges.add(edge.id);
          if (plannedRuns.has(target.id)) continue;
          const envelope = await envelopeBetween(
            run,
            node,
            target,
            row.output ?? [],
            row.iteration,
            {
              signal,
            },
          );
          envelopesFor.set(target.id, [...(envelopesFor.get(target.id) ?? []), envelope]);
        }
      }
    }

    /*
     * FR-EXE-011: COMPLETE only when every Output node finished and nothing is still going. A
     * workflow with no Output node (goal-driven nodes, D285) finishes on the nodes nothing is
     * downstream of — every one of them has to have COMPLETED. Loop edges point backwards (D73), so
     * only data edges make a node "upstream".
     */
    const outputNodes = nodes.filter((node) => node.kind === 'output');
    const feeds = new Set(
      edges.filter((edge) => edge.kind === 'data').map((edge) => edge.from.nodeId),
    );
    const finishLine =
      outputNodes.length > 0 ? outputNodes : nodes.filter((node) => !feeds.has(node.id));
    const graphComplete = (): boolean =>
      finishLine.length > 0 && finishLine.every((node) => states.get(node.id) === 'COMPLETED');

    /* The loop of Arch §12.3: mark ready, dispatch up to the limit, wait, repeat. */
    const inFlight = new Set<Promise<void>>();
    /** The nodes with a turn in flight, so a message never starts a second one (D309). */
    const inFlightNodes = new Set<Id>();
    const launch = (node: Node, trigger: TurnTriggerKind): void => {
      inFlightNodes.add(node.id);
      // Tracked on the gate as well as in `inFlight`, so `stop` can wait for the last in-flight
      // node before it writes the run row (FR-CTL-003).
      const release = gate.track(node.id);
      const promise = dispatch(node, iterations.get(node.id) ?? 1, trigger).finally(() => {
        release();
        inFlight.delete(promise);
        inFlightNodes.delete(node.id);
      });
      inFlight.add(promise);
    };
    /** Resolves when the run is stopped or shut down — a parked run waits on it too. */
    const abortedOrNever = new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    /** One wake-up at a time from the Domain: a message arrived, or the run is being ended. */
    let wakeUp: Promise<void> | undefined;
    const domainWake = (): Promise<void> =>
      domain === undefined
        ? new Promise<void>(() => undefined)
        : (wakeUp ??= domain.changed().then(() => {
            wakeUp = undefined;
          }));
    /** D323: `run.parked` is said once each time the run goes idle, not on every wake-up. */
    let parked = false;
    /**
     * D309: a node with nothing in flight that a waiting message names gets a turn now. D310: so
     * does an asker WAITING on its answer, and an envelope starts a turn even for a node the graph
     * has not dispatched yet.
     */
    const wantsTurnNow = (nodeId: Id): boolean => {
      const state = states.get(nodeId);
      if (inFlightNodes.has(nodeId) || state === undefined) return false;
      if (TURN_NOW_STATES.has(state) || state === 'WAITING') return true;
      return state === 'IDLE' && (domain?.pendingEnvelopes(nodeId).length ?? 0) > 0;
    };

    // §2.3: once a cap has been crossed the run dispatches nothing further. What is already in
    // flight is left to finish, exactly as a pause leaves it — a budget stops spending, it does not
    // throw away money already spent.
    while (!signal.aborted && budgetHalt === undefined) {
      // FR-CTL-001/002: a paused gate simply does not resolve, so no new node starts while the run
      // is paused and the ones already in flight are left to finish. `false` means it was aborted.
      if (!(await gate.waitUntilDispatchable())) break;
      // D323: an End starts nothing new; the turns it cut short unwind, then the run ends.
      const ending = domain?.endRequested() === true;
      // D313: over the budget nothing new starts — the run is BLOCKED until it is raised.
      if (!ending && (await checkBudget())) continue;
      // D310: what the human decided about held envelopes is carried out first.
      if (domain !== undefined && !ending) {
        for (const decision of domain.takeDecisions()) await applyDecision(decision);
      }

      if (!ending) {
        // D360: a retry or a re-run a control planned on this live run, once its node is free.
        for (const plan of domain?.plannedTurns() ?? []) {
          if (inFlight.size >= limit) break;
          const nodeId = plan.nodeRun.nodeId;
          const node = nodeById.get(nodeId);
          const state = states.get(nodeId);
          if (node !== undefined && (inFlightNodes.has(nodeId) || BUSY_STATES.has(state ?? 'IDLE')))
            continue;
          domain?.takePlannedTurn(nodeId);
          if (node === undefined) continue;
          const row = plan.nodeRun;
          plannedRuns.set(nodeId, row);
          envelopesFor.set(nodeId, asDelivered(row.inputEnvelopes, nodes));
          iterations.set(nodeId, row.iteration);
          const key = attemptKey(nodeId, row.iteration);
          lastAttempt.set(key, Math.max(lastAttempt.get(key) ?? 0, row.attempt));
          // D323: what this node's failure BLOCKED is unblocked, as a turn of it would, and runs
          // once the fresh output reaches it; what had completed runs again on that output
          // (`rearmSuccessors`), so `withDownstream` asks nothing more of a live run.
          for (const id of downstreamOf(nodeId, edges)) {
            if (states.get(id) === 'BLOCKED') states.set(id, 'IDLE');
          }
          stateBeforeTurn.set(nodeId, state ?? 'IDLE');
          launch(node, 'dispatch');
        }

        const ready = nodes.filter(
          (node) => states.get(node.id) === 'IDLE' && isReady(node, edges, deliveredEdges),
        );
        for (const node of ready) {
          if (inFlight.size >= limit) break;
          launch(node, 'dispatch');
        }

        for (const nodeId of domain?.nodesWantingTurn() ?? []) {
          if (inFlight.size >= limit) break;
          const node = nodeById.get(nodeId);
          if (node === undefined || !wantsTurnNow(nodeId)) continue;
          stateBeforeTurn.set(nodeId, states.get(nodeId) ?? 'IDLE');
          // A human message names the node (D309); otherwise an envelope reached it (D310).
          const human = domain?.pending(nodeId).some((message) => message.startsTurn) === true;
          launch(node, human ? 'instruction' : 'envelope');
        }
      }

      if (inFlight.size === 0) {
        if (domain === undefined || ending) break;

        if (stayOpen) {
          // D323: started from Domain, the run parks — RUNNING, calling nothing — until a message
          // names a node, the run is ended, or it is stopped.
          if (!parked) {
            parked = true;
            await bus.emit({
              type: 'run.parked',
              workflowId: run.workflowId,
              runId: run.id,
              payload: { runId: run.id, graph: graphComplete() ? 'complete' : 'failed' },
            });
          }
          await Promise.race([domainWake(), abortedOrNever]);
          continue;
        }

        // A board run ends here, unless a message slipped in first: the lock decides which, and a
        // message after it is refused rather than left waiting for a turn that never comes. One
        // with an envelope held for the human waits for the decision (D310).
        const woken = domainWake();
        const next = await domain.withLock(async () => {
          if (domain.nodesWantingTurn().some(wantsTurnNow)) return 'turn' as const;
          if (domain.awaitingHuman()) return 'wait' as const;
          await domain.close();
          return 'closed' as const;
        });
        if (next === 'closed') break;
        if (next === 'wait') await Promise.race([woken, abortedOrNever]);
        continue;
      }

      parked = false;
      await Promise.race([...inFlight, domainWake()]);
    }

    await Promise.allSettled(inFlight);

    // D310: an asker still waiting when the run ends never got its answer. A Stop ends it itself.
    if (!stoppedByControl()) {
      for (const [nodeId, row] of waitingRows) {
        states.set(nodeId, 'STOPPED');
        await repository.nodeRuns.update(scope, row.id, { status: 'STOPPED', endedAt: now() });
        await emitNodeState(run, row, 'STOPPED');
      }
    }

    // D360: a retry or a re-run the run ended before it could take never ran — STOPPED, not left
    // READY on a finished run. A Stop has already stopped every READY row itself.
    for (const plan of domain?.plannedTurns() ?? []) {
      domain?.takePlannedTurn(plan.nodeRun.nodeId);
      if (gate.abortCause() === 'stopped') continue;
      await repository.nodeRuns.update(scope, plan.nodeRun.id, { status: 'STOPPED', endedAt: now() });
      await emitNodeState(run, plan.nodeRun, 'STOPPED');
    }

    // D309: whatever is still PENDING was never delivered — DROPPED, before the run's end is said.
    // A Stop says its own end, and drops them itself before it does (FR-CTL-003).
    if (domain !== undefined && gate.abortCause() !== 'stopped') await domain.close();

    const allOutputsDone = graphComplete();
    const stillBusy = [...states.values()].some((state) => BUSY_STATES.has(state));

    const complete = allOutputsDone && !stillBusy && !signal.aborted && budgetHalt === undefined;
    summaryUsage.dropRun(run.id);
    const endedAt = now();
    const totals = sumUsage(usages);

    // Nobody is left to answer an approval on a run that is ending, so what is still pending is
    // rejected rather than left to wait for ever (FR-GRD-013, FR-CTL-003).
    if (deps.approvals !== undefined) {
      await deps.approvals.cancelPending(run.id, 'The run ended before this was decided.');
    }

    /*
     * FR-CTL-003: a Stop has already written HALTED `stopped` and emitted `run.completed` from the
     * control, on the clock the two-second budget is measured against. Writing again here would
     * overwrite that row's `endedAt` and put a second `run.completed` on the socket for one run, so
     * the drive leaves it alone and simply returns what the control wrote.
     */
    if (gate.abortCause() === 'stopped') {
      /*
       * The totals are the control's too — the sum of the node runs as they stood at the stop — but
       * a call the stop cut short records what it had already spent only as it unwinds, which can be
       * after that sum was taken. So the sum is taken again now that everything has unwound, and
       * the row (and the client, through `usage.updated`) is corrected if it moved (TC-OBS-002).
       */
      const stopped = (await repository.runs.get(scope, run.id)) ?? run;
      const spent = sumUsage(
        (await repository.nodeRuns.listByRun(scope, run.id)).map((nodeRun) => nodeRun.usage),
      );
      if (sameUsage(stopped.totals, spent)) return stopped;

      const corrected = await repository.runs.update(scope, run.id, { totals: spent });
      // The day's totals the Stop announced missed the same spend, so they are corrected with it.
      const dayTotals = await dayTotalsOf(run, now());
      await bus.emit({
        type: 'usage.updated',
        workflowId: run.workflowId,
        runId: run.id,
        payload: {
          runId: run.id,
          totals: spent,
          ...(dayTotals === undefined ? {} : { dayTotals }),
        },
      });
      return corrected ?? stopped;
    }

    const haltReason =
      gate.abortCause() ?? (budgetHalt === undefined ? 'failure' : 'budget_exceeded');
    // D80: `haltReason` alone cannot say "budget exceeded: $0.012 > $0.01 cap" — at the projected
    // check the totals are still *below* the cap, and the snapshot does not hold the cap.
    const halt =
      complete || budgetHalt === undefined || haltReason !== 'budget_exceeded'
        ? {}
        : { budgetHalt };

    const updated = await repository.runs.update(scope, run.id, {
      status: complete ? 'COMPLETE' : 'HALTED',
      // FR-CTL-006 / D71: the engine states which controls the run now accepts, so the UI never
      // guesses and the 409 the routes answer comes off the same table.
      allowedActions: allowedRunActions(complete ? 'COMPLETE' : 'HALTED'),
      ...(complete ? {} : { haltReason }),
      ...halt,
      totals,
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)),
      finalOutput,
    });

    // Round 5 §2.8 (FR-OBS-002): the run's end also carries the day's totals across every run, for
    // the top bar — announced before `run.completed`, so nothing about this run follows its end.
    await emitDayTotals(run, totals, endedAt);

    await bus.emit({
      type: 'run.completed',
      workflowId: run.workflowId,
      runId: run.id,
      payload: {
        runId: run.id,
        status: complete ? 'COMPLETE' : 'HALTED',
        ...(complete ? {} : { haltReason }),
        ...halt,
        totals,
        finalOutput,
      },
    });

    return updated ?? run;
  }

  /**
   * The UTC day's totals across every run (round 5 §2.8, FR-OBS-002), when a usage service is
   * wired. Best effort: a run's ending must not depend on a read model, so a failure is logged and
   * the run ends without them.
   */
  async function dayTotalsOf(run: Run, at: string): Promise<DayTotals | undefined> {
    if (deps.usage === undefined) return undefined;
    try {
      return await deps.usage.dayTotals(at.slice(0, 10));
    } catch (error) {
      logger.warn(
        { subsystem: 'runs', runId: run.id, err: error },
        'could not read the day totals',
      );
      return undefined;
    }
  }

  /**
   * `usage.updated` with this run's totals and the day's (FR-OBS-002), ahead of `run.completed` —
   * on every ending that spends: the drive's own, and a drive that threw (13a review m5). A Stop's
   * is the controls' to announce. Nothing goes out without a usage service.
   */
  async function emitDayTotals(run: Run, totals: Usage, at: string): Promise<void> {
    const dayTotals = await dayTotalsOf(run, at);
    if (dayTotals === undefined) return;
    await bus.emit({
      type: 'usage.updated',
      workflowId: run.workflowId,
      runId: run.id,
      payload: { runId: run.id, totals, dayTotals },
    });
  }

  /* --------------------------------------------------------------- service */

  /**
   * FR-EXE-011: the drive itself threw — a store that refused a write outside any one node, say.
   * The run still ends: HALTED (`failure`, or the shutdown that was under way) with its totals and
   * its `run.completed`, rather than RUNNING until the next start reaps it as crashed (FR-SYS-009).
   * Nobody is left to answer an approval on it (FR-GRD-013). A Stop has written its own ending
   * (FR-CTL-003), and a run that already ended keeps it. Best effort throughout: the store that
   * just failed may fail again.
   */
  async function haltAfterThrow(run: Run, gate: RunGate): Promise<Run> {
    try {
      await deps.approvals?.cancelPending(run.id, 'The run ended before this was decided.');
    } catch (error) {
      logger.error({ subsystem: 'runs', runId: run.id, err: error }, 'could not cancel approvals');
    }

    try {
      const stored = (await repository.runs.get(scope, run.id)) ?? run;
      if (gate.abortCause() === 'stopped' || ENDED_STATES.has(stored.status)) return stored;

      const haltReason = gate.abortCause() ?? 'failure';
      const totals = sumUsage(
        (await repository.nodeRuns.listByRun(scope, run.id)).map((nodeRun) => nodeRun.usage),
      );
      const endedAt = now();
      const halted = await repository.runs.update(scope, run.id, {
        status: 'HALTED',
        allowedActions: allowedRunActions('HALTED'),
        haltReason,
        totals,
        endedAt,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)),
      });

      // This ending spent money too: the day's totals go out ahead of it (FR-OBS-002, 13a m5).
      await emitDayTotals(run, totals, endedAt);

      await bus.emit({
        type: 'run.completed',
        workflowId: run.workflowId,
        runId: run.id,
        payload: { runId: run.id, status: 'HALTED', haltReason, totals },
      });
      return halted ?? stored;
    } catch (error) {
      logger.error({ subsystem: 'runs', runId: run.id, err: error }, 'could not halt a failed run');
      return run;
    }
  }

  /**
   * PG-5.1: the snapshot's nodes that can change the project folder, as configured (D361) — none
   * without a recorder or a folder.
   */
  async function writingNodes(run: Run, providers?: readonly Provider[]): Promise<ReadonlySet<Id>> {
    if (deps.checkpoints === undefined) return new Set();
    const project = await repository.projects.get(scope, run.projectId);
    if (project === null || project.folderPath === '') return new Set();
    const rows = providers ?? (await repository.providers.list(scope));
    const byId = new Map(rows.map((provider) => [provider.id, provider]));
    return new Set(
      run.snapshot.nodes
        .filter((node) => nodeWrites(node, (id) => byId.get(id)))
        .map((node) => node.id),
    );
  }

  /**
   * D300: the checkpoint of a run whose nodes only read, when its project has a folder; never a
   * reason the run fails. A run with a writing node has none: each writing step records its own
   * (PG-5.1), so a change is never listed twice.
   */
  async function beginRunCheckpoint(run: Run): Promise<CheckpointRecording | undefined> {
    const recorder = deps.checkpoints;
    if (recorder === undefined) return undefined;
    try {
      if ((await writingNodes(run)).size > 0) return undefined;
      const project = await repository.projects.get(scope, run.projectId);
      if (project === null || project.folderPath === '') return undefined;
      return await recorder.begin(run.projectId, { kind: 'run', runId: run.id });
    } catch (error) {
      logger.warn({ subsystem: 'runs', runId: run.id, err: error }, 'run checkpoint not begun');
      return undefined;
    }
  }

  /** PG-5.1: one writing node step's checkpoint; `undefined` without a folder or a recorder. */
  async function beginStepCheckpoint(
    run: Run,
    nodeId: Id,
  ): Promise<CheckpointRecording | undefined> {
    const recorder = deps.checkpoints;
    if (recorder === undefined) return undefined;
    try {
      const project = await repository.projects.get(scope, run.projectId);
      if (project === null || project.folderPath === '') return undefined;
      const recording = await recorder.begin(run.projectId, { kind: 'run', runId: run.id, nodeId });
      if (recording.failed !== undefined) {
        logger.warn(
          { subsystem: 'runs', runId: run.id, nodeId, reason: recording.failed },
          'node step checkpoint failed; its changes cannot be reverted',
        );
      }
      return recording;
    } catch (error) {
      logger.warn(
        { subsystem: 'runs', runId: run.id, nodeId, err: error },
        'node step checkpoint not begun',
      );
      return undefined;
    }
  }

  /**
   * PG-2.4 (D361): a writing run's checkpoint, begun before the run is RUNNING (`undefined` for a
   * run that only reads: it begins its own once driving). A run that writes (a node
   * with a project-writing tool, or a CLI allowed to edit) and whose checkpoint cannot begin gets an
   * error issue and is BLOCKED with zero provider calls — unless the person chose "Run without
   * undo" for this run, which leaves a warning instead. A run that only reads keeps D300's rule:
   * the failure is logged and the run goes on.
   */
  async function prepareUndo(
    run: Run,
    providers: readonly Provider[],
    withoutUndo: boolean,
  ): Promise<{ recording?: CheckpointRecording; issue?: ValidationIssue } | undefined> {
    const recorder = deps.checkpoints;
    if (recorder === undefined) return {};
    // A run that only reads begins its checkpoint once it is driving, as before (D300), so its
    // `POST /runs` still answers at once (D65); only a writer waits for the "before" snapshot.
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    const writer = run.snapshot.nodes.find((node) => nodeWrites(node, (id) => byId.get(id)));
    if (writer === undefined) return undefined;
    let reason: string | undefined;
    let recording: CheckpointRecording | undefined;
    try {
      const project = await repository.projects.get(scope, run.projectId);
      if (project === null || project.folderPath === '') return {};
      recording = await recorder.begin(run.projectId, {
        kind: 'run',
        runId: run.id,
        nodeId: writer.id,
      });
      reason = recording.failed;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    // PG-5.1: the store works, so each writing step will record its own checkpoint; this probe
    // recorded nothing and is dropped once finished.
    if (reason === undefined) {
      await recording?.finish().catch(() => undefined);
      return {};
    }

    logger.warn({ subsystem: 'runs', runId: run.id, reason }, 'run checkpoint not begun');
    const kept = recording === undefined ? {} : { recording };
    if (withoutUndo) {
      return {
        ...kept,
        issue: {
          severity: 'warning',
          code: 'running_without_undo',
          message: `Running without undo, as you chose: ${reason}. What this run changes cannot be reverted.`,
          nodeId: writer.id,
        },
      };
    }
    return {
      issue: {
        severity: 'error',
        code: 'checkpoint_unavailable',
        message: undoUnavailableMessage(reason, 'run'),
        nodeId: writer.id,
      },
    };
  }

  /**
   * Start driving a run that has been pre-flighted, and register its gate (FR-CTL-001..003).
   * `prepared` is the checkpoint `begin` already started (PG-2.4); a re-drive begins its own.
   */
  function startDriving(
    run: Run,
    seed?: DriveSeed,
    prepared?: { recording?: CheckpointRecording },
  ): Promise<Run> {
    const gate = createRunGate(run.id);
    const unregister = deps.gates.register(gate);
    let domain: RunDomain | undefined;
    let checkpoint: CheckpointRecording | undefined;

    const done = (async (): Promise<Run> => {
      // Domain (D309, D323): the run's live conversation, with what its log says it still owes.
      domain = await deps.domains?.open(run);
      checkpoint = prepared === undefined ? await beginRunCheckpoint(run) : prepared.recording;
      return drive(run, gate, seed, domain);
    })()
      .catch(async (error: unknown) => {
        logger.error({ subsystem: 'runs', runId: run.id, err: error }, 'run failed');
        await domain?.close().catch(() => undefined);
        return haltAfterThrow(run, gate);
      })
      .then(async (ended) => {
        domain?.settle(ended);
        // D300: what the run changed in the folder, recorded once it has stopped changing it
        await checkpoint?.finish().catch(() => undefined);
        return ended;
      })
      .finally(() => {
        unregister();
        if (domain !== undefined) deps.domains?.release(domain);
        active.delete(run.id);
      });

    active.set(run.id, {
      gate,
      done: done.then(
        () => undefined,
        () => undefined,
      ),
    });

    return done;
  }

  /**
   * Everything `beginRun` does once the run row exists: pre-flight, then drive (FR-EXE-003, BR-08).
   *
   * Extracted because `POST /runs/:id/restart` needs exactly this half and nothing of the half above
   * it — a restart records its own run on the *source run's* snapshot (BR-04, FR-CTL-004), so it
   * must not go back to the live tables for a fresh one.
   */
  /** PG-5.4: the recorded answer for a replayed node's call; nothing on any other run. */
  function replayFor(runId: Id, node: Node, iteration: number): Pick<ExecuteNodeInput, 'replay'> {
    const book = replays.get(runId);
    if (book === undefined || !isReplayedKind(node)) return {};
    return { replay: book.answer(node, iteration) };
  }

  async function begin(
    run: Run,
    extra: { issues?: ValidationIssue[]; seed?: DriveSeed; withoutUndo?: boolean } = {},
  ): Promise<BegunRun> {
    // PG-5.4: a replay calls no provider, so pre-flight asks none and it costs nothing to budget.
    const replaying = replays.has(run.id);
    const workflowId = run.workflowId;

    const [providers, models, mcpServers] = await Promise.all([
      repository.providers.list(scope),
      repository.models.list(scope, {}),
      repository.mcpServers?.list(scope),
    ]);

    const issues = [
      ...(extra.issues ?? []),
      ...(await preflight({
        nodes: run.snapshot.nodes,
        edges: run.snapshot.edges,
        inputs: run.inputs,
        providers,
        models,
        checkProvider: replaying
          ? () => Promise.resolve({ status: 'CONNECTED' as const, checkedAt: now() })
          : deps.checkProvider,
        // An agent that still enables a tool the registry no longer has — its MCP server was
        // removed — is refused here, before any node runs (round 4 §2.4, BR-08, D-069).
        ...(deps.tools === undefined ? {} : { tools: deps.tools }),
        ...(mcpServers === undefined ? {} : { mcpServers }),
        // A Retrieval node or an agent naming a base that no longer exists is refused before any
        // node runs (round 5 §2.4). A store without knowledge bases holds none, so none exists.
        knowledgeBaseExists: async (id) =>
          ((await repository.knowledgeBases?.get(scope, id)) ?? null) !== null,
        // An attached base whose embedding provider was removed cannot search: refused here too,
        // as `provider_missing` (FR-PRV-005, final-review I5).
        embeddingProviderOf: async (id) =>
          (await repository.knowledgeBases?.get(scope, id))?.embeddingProviderId,
        // The multimodal capability check reads an artifact's type through the same resolver the
        // Input node executor uses, so pre-flight and execution classify a `.png` identically
        // (round 4 §2.1, FR-MM-005). Absent the artifact store, the check does not run.
        ...(deps.artifacts === undefined
          ? {}
          : {
              artifactTypesFor: async (ids) =>
                (await deps.artifacts!.inputParts(ids)).map((part) => part.type),
            }),
      })),
    ];

    /*
     * §2.3: today's spend is already at the daily cap, so the run is BLOCKED with
     * `daily_budget_exceeded` and **zero** provider calls. Checked against the project's default
     * policy, because pre-flight is about the run rather than about one node.
     */
    if (deps.budgets !== undefined && !replaying) {
      const policy =
        deps.policies === undefined ? null : await deps.policies.resolve(run.projectId);
      issues.push(...(await deps.budgets.preflightIssues({ projectId: run.projectId, policy })));
    }

    // PG-2.4 (D361): only a run that would otherwise start begins a checkpoint; a writing run whose
    // checkpoint cannot begin is BLOCKED here, before any provider call or file write.
    let undo: { recording?: CheckpointRecording; issue?: ValidationIssue } | undefined;
    if (replaying) {
      // A replay writes nothing — no tool runs — so it records no checkpoint (D300).
      undo = {};
    } else if (!issues.some((issue) => issue.severity === 'error')) {
      undo = await prepareUndo(run, providers, extra.withoutUndo === true);
      if (undo?.issue !== undefined) issues.push(undo.issue);
    }
    const ranWithoutUndo = undo?.issue?.code === 'running_without_undo';

    // Every issue `preflight` itself raises is an error; only a `warn` daily budget can be a
    // warning, and D79 says that one reports and lets the run start.
    if (issues.some((issue) => issue.severity === 'error')) {
      // BLOCKED, with zero generate() calls (BR-08). Still a run: it is recorded, inspectable
      // and listed in the history, because "why did it not start" is a question worth keeping.
      const withIssues = (await repository.runs.update(scope, run.id, {
        status: 'BLOCKED',
        allowedActions: allowedRunActions('BLOCKED'),
        preflightIssues: issues,
        endedAt: now(),
        durationMs: 0,
      })) ?? {
        ...run,
        status: 'BLOCKED' as const,
        allowedActions: allowedRunActions('BLOCKED'),
        preflightIssues: issues,
      };

      await bus.emit({
        type: 'run.started',
        workflowId,
        runId: run.id,
        payload: { run: toSummary(withIssues) },
      });
      await bus.emit({
        type: 'run.completed',
        workflowId,
        runId: run.id,
        // D303: the issues travel with the ending, so the conversation can say why it never ran.
        payload: {
          runId: run.id,
          status: 'BLOCKED',
          totals: withIssues.totals,
          preflightIssues: issues,
        },
      });

      logger.info(
        { subsystem: 'runs', runId: run.id, issues: issues.length },
        'run blocked by pre-flight',
      );
      return { run: withIssues, done: Promise.resolve(withIssues) };
    }

    const running =
      (await repository.runs.update(scope, run.id, {
        status: 'RUNNING',
        // D323: a run started from Domain can be ended from the start.
        allowedActions: allowedRunActions('RUNNING', { stayOpen: run.domain?.stayOpen }),
        // A warning pre-flight raised is kept on the row: a run that started with a note is still
        // a run whose note the user should see (D79).
        ...(issues.length === 0 ? {} : { preflightIssues: issues }),
      })) ?? run;

    await bus.emit({
      type: 'run.started',
      workflowId,
      runId: run.id,
      // PG-2.4 (D361): the one-time "Run without undo" is written to the run's events.
      payload: { run: toSummary(running), ...(ranWithoutUndo ? { withoutUndo: true } : {}) },
    });

    // D312: a run that came with Domain settings records them, then its goal as the first message.
    if (running.domain !== undefined) {
      await bus.emit({
        type: 'run.config',
        workflowId,
        runId: run.id,
        payload: { runId: run.id, config: running.domain },
      });
    }
    if (running.goal !== undefined) {
      await bus.emit({
        type: 'human.message',
        workflowId,
        runId: run.id,
        payload: {
          runId: run.id,
          messageId: nextId(),
          text: running.goal,
          addressing: 'goal',
          mentions: [],
          deliveryMode: 'queue',
        },
      });
    }

    return { run: running, done: startDriving(running, extra.seed, undo) };
  }

  const service: RunService = {
    async beginRun(workflowId, request) {
      const workflow = await repository.workflows.get(scope, workflowId);
      if (workflow === null) throw notFound(`workflow ${workflowId}`);

      const startedAt = now();
      // D312: a goal and Domain settings, with their defaults, as the run will keep them.
      const domainConfig =
        request.domain === undefined ? undefined : RunDomainConfigInputSchema.parse(request.domain);
      const goal =
        request.goal?.trim() === '' ? undefined : maskSecrets(request.goal ?? '') || undefined;

      // BR-04: the snapshot and the run row are written together, so there is no instant at
      // which a run exists without the graph it is going to execute.
      const run = await repository.transaction(async (tx) => {
        const [nodes, edges] = await Promise.all([
          tx.nodes.listByWorkflow(scope, workflowId),
          tx.edges.listByWorkflow(scope, workflowId),
        ]);

        // D312: with no inputs given, the goal is what every Input node hands on.
        const inputs: Record<Id, Part[]> =
          request.inputs !== undefined || goal === undefined
            ? (request.inputs ?? {})
            : Object.fromEntries(
                nodes
                  .filter((node) => node.kind === 'input')
                  .map((node): [Id, Part[]] => [node.id, [{ type: 'text', text: goal }]]),
              );

        const created: Run = {
          id: nextId(),
          workflowId,
          projectId: workflow.projectId,
          status: 'PREFLIGHT',
          allowedActions: allowedRunActions('PREFLIGHT'),
          snapshot: { version: workflow.version, nodes, edges },
          inputs,
          preflightIssues: [],
          totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          startedAt,
          ...(domainConfig === undefined ? {} : { domain: domainConfig }),
          ...(goal === undefined ? {} : { goal }),
        };

        return tx.runs.create(scope, created);
      });

      if (request.startFromNodeId === undefined)
        return begin(run, { withoutUndo: request.withoutUndo === true });

      /*
       * Start from a node (FR-EXE-013, TC-EXE-012, D83). Every node above the chosen one has its
       * last COMPLETED node run **copied** — zero usage, `reusedFromNodeRunId` set — so nothing is
       * called again and the inspector still shows what the start node actually read. An upstream
       * node no earlier run ever completed blocks the run at pre-flight with
       * `missing_upstream_output`, naming it.
       */
      const plan = await planStartFrom({
        startFromNodeId: request.startFromNodeId,
        nodes: run.snapshot.nodes,
        edges: run.snapshot.edges,
        runId: run.id,
        // Newest first, as `planStartFrom` reads them, and without this run itself.
        earlierRuns: (
          await repository.runs.listByWorkflow(scope, workflowId, { limit: 50 })
        ).items.filter((candidate) => candidate.id !== run.id),
        nodeRunsOf: (runId) => repository.nodeRuns.listByRun(scope, runId),
        nextId,
        now,
      });

      // Only when the plan is whole: inserting copies for a run that is about to be BLOCKED would
      // leave a blocked run holding node runs it never had (TC-EXE-012's second half).
      if (plan.issues.length === 0) {
        for (const reused of plan.reused) await repository.nodeRuns.create(scope, reused);
      }

      return begin(run, {
        issues: plan.issues,
        withoutUndo: request.withoutUndo === true,
        // The copies are already COMPLETED rows, so the generic seed marks them COMPLETED and
        // delivers their outputs; the start node is IDLE and becomes ready when they land.
        seed: { nodeRuns: [], withDownstream: false },
      });
    },

    async driveRecordedRun(run) {
      return (await begin(run)).run;
    },

    async driveReplayRun(run) {
      const sourceRunId = run.replayOf;
      if (sourceRunId === undefined) throw new Error(`run ${run.id} is not a replay`);
      const sourceNodeRuns = await repository.nodeRuns.listByRun(scope, sourceRunId);
      replays.set(run.id, createReplayBook(sourceRunId, run.snapshot, sourceNodeRuns));
      try {
        const begun = await begin(run);
        void begun.done.finally(() => replays.delete(run.id));
        return begun.run;
      } catch (error) {
        replays.delete(run.id);
        throw error;
      }
    },

    async resumeOpenRun(run) {
      // D323: no pre-flight — the run had one; everything it recorded is seeded as it was, nothing is
      // forced to run again, and with nothing to do it parks.
      void startDriving(run, { nodeRuns: [], withDownstream: false });
      return run;
    },

    async drivePartialRun(plan) {
      // No pre-flight: the run has already been through it, and D82 makes its snapshot — not the
      // live workflow — what it executes. What is new is only which nodes run again.
      void startDriving(plan.run, {
        nodeRuns: plan.nodeRuns,
        withDownstream: plan.withDownstream,
      });
      return plan.run;
    },

    async envelopesFor(run, nodeId) {
      const node = run.snapshot.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) throw notFound(`node ${nodeId} in run ${run.id}`);

      const rows = await repository.nodeRuns.listByRun(scope, run.id);
      const completed = latestByNode(rows.filter((row) => row.status === 'COMPLETED'));

      const envelopes: Envelope[] = [];
      const seen = new Set<Id>();

      for (const edge of run.snapshot.edges) {
        if (edge.kind !== 'data' || edge.to.nodeId !== nodeId) continue;
        if (seen.has(edge.from.nodeId)) continue;

        const from = run.snapshot.nodes.find((candidate) => candidate.id === edge.from.nodeId);
        const row = completed.get(edge.from.nodeId);
        if (from === undefined || row === undefined) continue;

        seen.add(edge.from.nodeId);
        envelopes.push(
          await envelopeBetween(run, from, node, row.output ?? [], row.iteration, {
            record: false,
          }),
        );
      }

      return envelopes;
    },

    async startRun(workflowId, request) {
      const { done } = await service.beginRun(workflowId, request);
      return done;
    },

    async getRun(runId) {
      const run = await repository.runs.get(scope, runId);
      if (run === null) throw notFound(`run ${runId}`);
      return run;
    },

    async listRuns(workflowId, page) {
      const runs = await repository.runs.listByWorkflow(scope, workflowId, page);
      return {
        items: runs.items.map(toSummary),
        ...(runs.nextCursor === undefined ? {} : { nextCursor: runs.nextCursor }),
      };
    },

    listNodeRuns: (runId) => repository.nodeRuns.listByRun(scope, runId),

    async getNodeRun(nodeRunId) {
      const nodeRun = await repository.nodeRuns.get(scope, nodeRunId);
      if (nodeRun === null) throw notFound(`node run ${nodeRunId}`);
      return nodeRun;
    },

    async shutdown() {
      // Every gate, not only this service's: a run driven through a control still has a gate here
      // and `shutdown` is the one halt that must reach all of them (FR-SYS-008, FR-CTL-003).
      for (const gate of deps.gates.all()) gate.shutdown();
      for (const { gate } of active.values()) gate.shutdown();
      await Promise.allSettled([...active.values()].map((entry) => entry.done));
    },

    activeRunCount: () => active.size,
  };

  return service;
}

/** Catalog rows as the router wants them — exported for the composition root. */
export function toRouterModels(models: readonly Model[]) {
  return models.map((model) => ({
    providerId: model.providerId,
    modelId: model.modelId,
    available: model.available,
    inputTypes: model.inputTypes,
    outputTypes: model.outputTypes,
    ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
  }));
}
