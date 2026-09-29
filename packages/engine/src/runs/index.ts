import {
  allowedRunActions,
  DEFAULT_CONCURRENCY,
  type BudgetHalt,
  type CursorQuery,
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
  type ProviderCheckResult,
  type Run,
  type RunSummary,
  type StartRunRequest,
  type Usage,
  type ValidationIssue,
} from '@ace/contracts';

import type { ApprovalService } from '../approvals/index.js';
import type { BudgetService } from '../budgets/index.js';
import type { EvaluationTarget, GuardrailEvaluator } from '../guardrails/evaluator.js';
import { policyRef, type PolicyService } from '../guardrails/policy-service.js';
import { contractFor, createTruncatingSummariser, estimatePartsTokens, trustForSource, type Summariser } from '../envelopes/index.js';
import { buildEnvelope } from '../envelopes/index.js';
import { autoRetryDecision, upstreamFailedError, userCancelledError } from '../errors/index.js';
import type { EventBus } from '../events/index.js';
import { notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { ModelRouter, ProviderAdapter, Repository, Scope } from '../ports/index.js';
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
import { createMergeArrivalLog, executeMergeNode, isMergeReady } from '../merge/index.js';
import { downstreamOf } from './control/graph.js';
import { createRunGate, type RunGate, type RunGateRegistry } from './control/gate.js';
import type { PartialRunPlan } from './control/service.js';
import { planStartFrom } from './control/start-from.js';
import { sumUsage } from './cost.js';
import {
  createNodeExecutor,
  type NodeExecutionOutcome,
  type NodeExecutor,
  type NodeGuardrails,
} from './executor.js';
import { preflight } from './preflight.js';
import { toSummary } from './summary.js';

export * from './cost.js';
export * from './executor.js';
export * from './preflight.js';
export * from './transform.js';
export * from './machines/index.js';
export * from './lifecycle.js';
export * from './control/index.js';
export * from './summary.js';

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
   * Re-opens a recorded run and drives the node runs in the plan, plus everything after them when
   * the plan says so (D81, FR-CTL-005, FR-ERR-003, FR-ERR-004). Resolves once it is going again.
   */
  drivePartialRun(plan: PartialRunPlan): Promise<Run>;
  /**
   * The envelopes a node would receive from the **latest** COMPLETED upstream outputs of this run —
   * what a re-run executes on (FR-CTL-005). Without it a re-run runs with no reads at all.
   */
  envelopesFor(run: Run, nodeId: Id): Promise<Envelope[]>;

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

  summariser?: Summariser;
  now?: () => string;
  nextId?: () => string;
  tokenBatchMs?: number;
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

/** Node states that mean the run still has work in flight (Arch §19.2). */
const BUSY_STATES: ReadonlySet<NodeState> = new Set<NodeState>(['RUNNING', 'READY', 'WAITING']);

export function createRunService(deps: RunServiceDeps): RunService {
  const { repository, scope, bus, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;
  const summariser = deps.summariser ?? createTruncatingSummariser();

  const executor: NodeExecutor = createNodeExecutor({
    bus,
    logger,
    adapterFor: deps.adapterFor,
    modelsFor: () => repository.models.list(scope, {}),
    runGated: deps.runGated,
    router: deps.router,
    ...(deps.tokenBatchMs === undefined ? {} : { tokenBatchMs: deps.tokenBatchMs }),
  });

  /** Every run this process is currently driving, so shutdown can abort them (FR-SYS-008). */
  const active = new Map<Id, { gate: RunGate; done: Promise<void> }>();

  async function emitNodeState(
    run: Run,
    nodeRun: NodeRun,
    status: NodeState,
    failureReason?: NodeRun['failureReason'],
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
  function envelopeBetween(
    run: Run,
    from: Node,
    to: Node,
    parts: Part[],
    iteration: number,
  ): Envelope {
    const budgetTokens =
      to.kind === 'agent' ? to.config.contextPolicy.budgetTokens : Number.MAX_SAFE_INTEGER;
    const outputTypes =
      to.kind === 'agent' || to.kind === 'model' ? to.config.outputTypes : ['text' as const];

    return buildEnvelope(
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
      },
      summariser,
    );
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

  async function drive(run: Run, gate: RunGate, seed?: DriveSeed): Promise<Run> {
    const signal = gate.signal;
    const { nodes, edges } = run.snapshot;
    const settings = await repository.settings.get(scope);
    const limit = settings.concurrency > 0 ? settings.concurrency : DEFAULT_CONCURRENCY;

    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const states = new Map<Id, NodeState>(nodes.map((node) => [node.id, 'IDLE' as NodeState]));
    const nodeRunByNode = new Map<Id, NodeRun>();
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
      if (evaluator === undefined) return {};
      const target = targetFor(node, nodeRun);

      return {
        guardrails: {
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
    async function beginNodeRun(node: Node, iteration: number, attempt = 1): Promise<NodeRun> {
      const aborted = signal.aborted;
      const nodeRun: NodeRun = {
        id: nextId(),
        runId: run.id,
        nodeId: node.id,
        iteration,
        attempt,
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
        await repository.nodeRuns.update(scope, nodeRun.id, {
          status: 'STOPPED',
          error: cancelledBeforeStart(),
        });
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

        envelopesFor.set(targetId, [
          ...(envelopesFor.get(targetId) ?? []),
          envelopeBetween(run, node, target, parts, iteration),
        ]);
      }

      for (const edge of outgoing) {
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
      usages.push(outcome.usage);

      await repository.nodeRuns.update(scope, nodeRun.id, {
        status: outcome.status,
        ...(outcome.failureReason === undefined ? {} : { failureReason: outcome.failureReason }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.modelUsed === undefined ? {} : { modelUsed: outcome.modelUsed }),
        ...(outcome.prompt === undefined ? {} : { prompt: outcome.prompt }),
        output: outcome.output,
        usage: outcome.usage,
        endedAt,
      });

      // Totals are the running sum of the node runs, so the number a client sees mid-run is the
      // same arithmetic as the number stored at the end (TC-OBS-002).
      await bus.emit({
        type: 'usage.updated',
        workflowId: run.workflowId,
        runId: run.id,
        payload: { runId: run.id, totals: sumUsage(usages) },
      });
    }

    async function finish(
      node: Node,
      nodeRun: NodeRun,
      outcome: NodeExecutionOutcome,
      endedAt: string = now(),
    ): Promise<void> {
      const iteration = nodeRun.iteration;
      await recordAttempt(nodeRun, outcome, endedAt);

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
      let requeued = false;

      if (outcome.status === 'COMPLETED') {
        if (node.kind === 'output') finalOutput[node.id] = outcome.output;

        const loopEdgeOfNode = loops.loopFor(node.id);
        const body = loopEdgeOfNode === undefined ? undefined : loops.body(loopEdgeOfNode.id);
        // Every body node's last output is remembered: `repeated_output` counts them (FR-GRD-009)
        // and the outward deliveries held back while the loop ran are flushed from it (§2.4).
        if (body !== undefined) loops.remember(node.id, outcome.output);

        const { inside } = splitOutgoing(node.id, edges, body);
        await deliver(node, outcome.output, iteration, inside);

        /* Every loop this node is the source of decides now (FR-PAR-003..006, FR-GRD-009). */
        for (const loopEdge of loops.loopEdgesFrom(node.id)) {
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
            const failure = loopFailure(decision);
            status = 'FAILED';
            failureReason = failure.failureReason;
            await repository.nodeRuns.update(scope, nodeRun.id, {
              status: 'FAILED',
              failureReason: failure.failureReason,
              error: failure.error,
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

      // The requeue has already put the whole body back to IDLE at the next iteration, so only the
      // scheduler's own bookkeeping is conditional; the frame names this node run, which really did
      // finish, so the inspector still sees the iteration close.
      if (!requeued) states.set(node.id, status);
      await emitNodeState(run, nodeRun, status, failureReason);

      if (status !== 'COMPLETED' && !requeued) await blockDownstream(node);
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
    async function dispatch(node: Node, iteration: number): Promise<void> {
      // `states` is the scheduler's own bookkeeping: dispatched, so never picked up twice. The node
      // run itself stays READY until it holds its provider slot (D66, FR-PRV-009).
      states.set(node.id, 'RUNNING');

      const maxRetries =
        node.kind === 'agent' || node.kind === 'model' ? node.config.execution.retries : 0;

      let attempt = plannedRuns.get(node.id)?.attempt ?? 1;
      let contractRepairs = 0;
      let repairReason: string | undefined;

      await resolvePolicy(node);

      // The row a control already created and already answered the client with, used once. A second
      // row here would leave the client holding the id of a node run that never ran.
      const planned = plannedRuns.get(node.id);
      plannedRuns.delete(node.id);
      let nodeRun = planned ?? (await beginNodeRun(node, iteration, attempt));
      if (planned !== undefined) await emitNodeState(run, planned, 'READY');
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
            await repository.nodeRuns.update(scope, nodeRun.id, { status: 'STOPPED', endedAt: at });
            states.set(node.id, 'STOPPED');
            await emitNodeState(run, nodeRun, 'STOPPED');
            return;
          }
        }

        let running = false;
        /** When an agent's provider call ended, if it made one; else the node ends at finish. */
        let endedAt: string | undefined;
        const markRunning = async (): Promise<void> => {
          if (running) return;
          running = true;
          await repository.nodeRuns.update(scope, nodeRun.id, {
            status: 'RUNNING',
            startedAt: now(),
          });
          await emitNodeState(run, nodeRun, 'RUNNING');
        };

        const outcome =
          node.kind === 'merge'
            ? await (async (): Promise<NodeExecutionOutcome> => {
                // A merge calls no provider and costs nothing, so it starts the instant it is
                // dispatched; its output is a function of what arrived (FR-PAR-002).
                await markRunning();
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
                signal,
                onStarted: markRunning,
                onEnded: () => {
                  endedAt = now();
                },
                ...guardrailsFor(node, nodeRun),
                ...(repairReason === undefined ? {} : { repairReason }),
              });

        // A node that failed before it got a slot (no route, say) still passes through RUNNING, so
        // every node run follows Arch §19.1: READY → RUNNING → a terminal state.
        await markRunning();

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
            nodeRun = await beginNodeRun(node, iteration, attempt);
            if (nodeRun.status === 'STOPPED') {
              states.set(node.id, 'STOPPED');
              return;
            }

            // Cut short by a stop; a pause is `holdWhilePaused`'s, at the top of the next attempt.
            await backoff(decision.delayMs);
            continue;
          }
        }

        await finish(node, nodeRun, outcome, endedAt);
        return;
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
        envelopesFor.set(row.nodeId, [...row.inputEnvelopes]);
        iterations.set(row.nodeId, row.iteration);
      }

      const recorded = latestByNode(await repository.nodeRuns.listByRun(scope, run.id));

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
          envelopesFor.set(target.id, [
            ...(envelopesFor.get(target.id) ?? []),
            envelopeBetween(run, node, target, row.output ?? [], row.iteration),
          ]);
        }
      }
    }

    /* The loop of Arch §12.3: mark ready, dispatch up to the limit, wait, repeat. */
    const inFlight = new Set<Promise<void>>();

    // §2.3: once a cap has been crossed the run dispatches nothing further. What is already in
    // flight is left to finish, exactly as a pause leaves it — a budget stops spending, it does not
    // throw away money already spent.
    while (!signal.aborted && budgetHalt === undefined) {
      // FR-CTL-001/002: a paused gate simply does not resolve, so no new node starts while the run
      // is paused and the ones already in flight are left to finish. `false` means it was aborted.
      if (!(await gate.waitUntilDispatchable())) break;

      const ready = nodes.filter(
        (node) => states.get(node.id) === 'IDLE' && isReady(node, edges, deliveredEdges),
      );

      for (const node of ready) {
        if (inFlight.size >= limit) break;
        // Tracked on the gate as well as in `inFlight`, so `stop` can wait for the last in-flight
        // node before it writes the run row (FR-CTL-003).
        const release = gate.track(node.id);
        const promise = dispatch(node, iterations.get(node.id) ?? 1).finally(() => {
          release();
          inFlight.delete(promise);
        });
        inFlight.add(promise);
      }

      if (inFlight.size === 0) break;
      await Promise.race(inFlight);
    }

    await Promise.allSettled(inFlight);

    /* FR-EXE-011: COMPLETE only when every Output node finished and nothing is still going. */
    const outputNodes = nodes.filter((node) => node.kind === 'output');
    const allOutputsDone =
      outputNodes.length > 0 &&
      outputNodes.every((node) => states.get(node.id) === 'COMPLETED');
    const stillBusy = [...states.values()].some((state) => BUSY_STATES.has(state));

    const complete =
      allOutputsDone && !stillBusy && !signal.aborted && budgetHalt === undefined;
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
      return (await repository.runs.get(scope, run.id)) ?? run;
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

  /* --------------------------------------------------------------- service */

  /** Start driving a run that has been pre-flighted, and register its gate (FR-CTL-001..003). */
  function startDriving(run: Run, seed?: DriveSeed): Promise<Run> {
    const gate = createRunGate(run.id);
    const unregister = deps.gates.register(gate);

    const done = drive(run, gate, seed)
      .catch(async (error: unknown) => {
        // The drive threw rather than halting cleanly; the row is still the truth about the run.
        logger.error({ subsystem: 'runs', runId: run.id, err: error }, 'run failed');
        return (await repository.runs.get(scope, run.id)) ?? run;
      })
      .finally(() => {
        unregister();
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
  async function begin(
    run: Run,
    extra: { issues?: ValidationIssue[]; seed?: DriveSeed } = {},
  ): Promise<BegunRun> {
    const workflowId = run.workflowId;

    const [providers, models] = await Promise.all([
      repository.providers.list(scope),
      repository.models.list(scope, {}),
    ]);

    const issues = [
      ...(extra.issues ?? []),
      ...(await preflight({
        nodes: run.snapshot.nodes,
        edges: run.snapshot.edges,
        inputs: run.inputs,
        providers,
        models,
        checkProvider: deps.checkProvider,
      })),
    ];

    /*
     * §2.3: today's spend is already at the daily cap, so the run is BLOCKED with
     * `daily_budget_exceeded` and **zero** provider calls. Checked against the project's default
     * policy, because pre-flight is about the run rather than about one node.
     */
    if (deps.budgets !== undefined) {
      const policy =
        deps.policies === undefined ? null : await deps.policies.resolve(run.projectId);
      issues.push(...(await deps.budgets.preflightIssues({ projectId: run.projectId, policy })));
    }

    // Every issue `preflight` itself raises is an error; only a `warn` daily budget can be a
    // warning, and D79 says that one reports and lets the run start.
    if (issues.some((issue) => issue.severity === 'error')) {
      // BLOCKED, with zero generate() calls (BR-08). Still a run: it is recorded, inspectable
      // and listed in the history, because "why did it not start" is a question worth keeping.
      const withIssues =
        (await repository.runs.update(scope, run.id, {
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
        payload: { runId: run.id, status: 'BLOCKED', totals: withIssues.totals },
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
        allowedActions: allowedRunActions('RUNNING'),
        // A warning pre-flight raised is kept on the row: a run that started with a note is still
        // a run whose note the user should see (D79).
        ...(issues.length === 0 ? {} : { preflightIssues: issues }),
      })) ?? run;

    await bus.emit({
      type: 'run.started',
      workflowId,
      runId: run.id,
      payload: { run: toSummary(running) },
    });

    return { run: running, done: startDriving(running, extra.seed) };
  }

  const service: RunService = {
    async beginRun(workflowId, request) {
      const workflow = await repository.workflows.get(scope, workflowId);
      if (workflow === null) throw notFound(`workflow ${workflowId}`);

      const startedAt = now();

      // BR-04: the snapshot and the run row are written together, so there is no instant at
      // which a run exists without the graph it is going to execute.
      const run = await repository.transaction(async (tx) => {
        const [nodes, edges] = await Promise.all([
          tx.nodes.listByWorkflow(scope, workflowId),
          tx.edges.listByWorkflow(scope, workflowId),
        ]);

        const created: Run = {
          id: nextId(),
          workflowId,
          projectId: workflow.projectId,
          status: 'PREFLIGHT',
          allowedActions: allowedRunActions('PREFLIGHT'),
          snapshot: { version: workflow.version, nodes, edges },
          inputs: request.inputs ?? {},
          preflightIssues: [],
          totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
          startedAt,
        };

        return tx.runs.create(scope, created);
      });

      if (request.startFromNodeId === undefined) return begin(run);

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
        // The copies are already COMPLETED rows, so the generic seed marks them COMPLETED and
        // delivers their outputs; the start node is IDLE and becomes ready when they land.
        seed: { nodeRuns: [], withDownstream: false },
      });
    },

    async driveRecordedRun(run) {
      return (await begin(run)).run;
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
        envelopes.push(envelopeBetween(run, from, node, row.output ?? [], row.iteration));
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
