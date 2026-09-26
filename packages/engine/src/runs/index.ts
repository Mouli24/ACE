import {
  allowedRunActions,
  DEFAULT_CONCURRENCY,
  type CursorQuery,
  type Edge,
  type Envelope,
  type GuardrailPolicy,
  type Id,
  type Model,
  type Node,
  type NodeRun,
  type NodeState,
  type Page,
  type Part,
  type ProviderCheckResult,
  type Run,
  type RunSummary,
  type StartRunRequest,
  type Usage,
} from '@ace/contracts';

import { contractFor, createTruncatingSummariser, estimatePartsTokens, trustForSource, type Summariser } from '../envelopes/index.js';
import { buildEnvelope } from '../envelopes/index.js';
import { autoRetryDecision } from '../errors/index.js';
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
import { sumUsage } from './cost.js';
import { createNodeExecutor, type NodeExecutionOutcome, type NodeExecutor } from './executor.js';
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

  async function drive(run: Run, gate: RunGate): Promise<Run> {
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

    /** One node run row per node per iteration, created when that iteration is dispatched. */
    async function beginNodeRun(node: Node, iteration: number, attempt = 1): Promise<NodeRun> {
      const nodeRun: NodeRun = {
        id: nextId(),
        runId: run.id,
        nodeId: node.id,
        iteration,
        attempt,
        status: 'READY',
        inputEnvelopes: envelopesFor.get(node.id) ?? [],
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        verdicts: [],
        toolCalls: [],
        // No startedAt yet: it is stamped when the node starts, not when it joins its provider's
        // queue (D66).
      };

      await repository.nodeRuns.create(scope, nodeRun);
      nodeRunByNode.set(node.id, nodeRun);
      await emitNodeState(run, nodeRun, 'READY');
      return nodeRun;
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

        const budgetTokens =
          target.kind === 'agent' ? target.config.contextPolicy.budgetTokens : Number.MAX_SAFE_INTEGER;
        const outputTypes =
          target.kind === 'agent' || target.kind === 'model' ? target.config.outputTypes : ['text' as const];

        const envelope = buildEnvelope(
          {
            id: nextId(),
            runId: run.id,
            fromNodeId: node.id,
            toNodeId: targetId,
            iteration,
            parts,
            budgetTokens,
            // BR-13: only an Input node's content is trusted.
            trust: trustForSource(node.kind),
            contract: contractFor(
              outputTypes,
              target.kind === 'agent' ? target.config.outputContract?.jsonSchema : undefined,
            ),
            createdAt: now(),
          },
          summariser,
        );

        envelopesFor.set(targetId, [...(envelopesFor.get(targetId) ?? []), envelope]);
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

      let attempt = 1;
      let contractRepairs = 0;
      let repairReason: string | undefined;

      for (;;) {
        const nodeRun = await beginNodeRun(node, iteration, attempt);

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

            await backoff(decision.delayMs);
            if (signal.aborted) return;

            attempt = decision.nextAttempt;
            if (decision.repairPrompt) {
              contractRepairs += 1;
              repairReason = outcome.error.message;
            }
            continue;
          }
        }

        await finish(node, nodeRun, outcome, endedAt);
        return;
      }
    }

    /* The loop of Arch §12.3: mark ready, dispatch up to the limit, wait, repeat. */
    const inFlight = new Set<Promise<void>>();

    while (!signal.aborted) {
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

    const complete = allOutputsDone && !stillBusy && !signal.aborted;
    const endedAt = now();
    const totals = sumUsage(usages);

    /*
     * FR-CTL-003: a Stop has already written HALTED `stopped` and emitted `run.completed` from the
     * control, on the clock the two-second budget is measured against. Writing again here would
     * overwrite that row's `endedAt` and put a second `run.completed` on the socket for one run, so
     * the drive leaves it alone and simply returns what the control wrote.
     */
    if (gate.abortCause() === 'stopped') {
      return (await repository.runs.get(scope, run.id)) ?? run;
    }

    const haltReason = gate.abortCause() ?? 'failure';

    const updated = await repository.runs.update(scope, run.id, {
      status: complete ? 'COMPLETE' : 'HALTED',
      // FR-CTL-006 / D71: the engine states which controls the run now accepts, so the UI never
      // guesses and the 409 the routes answer comes off the same table.
      allowedActions: allowedRunActions(complete ? 'COMPLETE' : 'HALTED'),
      ...(complete ? {} : { haltReason }),
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
        totals,
        finalOutput,
      },
    });

    return updated ?? run;
  }

  /* --------------------------------------------------------------- service */

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

      const [providers, models] = await Promise.all([
        repository.providers.list(scope),
        repository.models.list(scope, {}),
      ]);

      const issues = await preflight({
        nodes: run.snapshot.nodes,
        edges: run.snapshot.edges,
        inputs: run.inputs,
        providers,
        models,
        checkProvider: deps.checkProvider,
      });

      if (issues.length > 0) {
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
        })) ?? run;

      await bus.emit({
        type: 'run.started',
        workflowId,
        runId: run.id,
        payload: { run: toSummary(running) },
      });

      const gate = createRunGate(run.id);
      const unregister = deps.gates.register(gate);
      const done = drive(running, gate)
        .catch(async (error: unknown) => {
          // The drive threw rather than halting cleanly; the row is still the truth about the run.
          logger.error({ subsystem: 'runs', runId: run.id, err: error }, 'run failed');
          return (await repository.runs.get(scope, run.id)) ?? running;
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

      return { run: running, done };
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
