import {
  allowedRunActions,
  zeroUsage,
  type Envelope,
  type Id,
  type NodeRun,
  type NodeState,
  type RetryRequest,
  type Run,
} from '@ace/contracts';

import type { EmittedEvent } from '../../events/index.js';
import { notFound } from '../../gateway/errors.js';
import { newId } from '../../ids.js';
import type { Logger } from '../../logging/index.js';
import { sumUsage } from '../cost.js';
import { assertRunAction, withAllowedActions } from './actions.js';
import type { RunGateRegistry } from './gate.js';
import { downstreamOf } from './graph.js';
import type { ControlNodeRunStore, ControlRunStore } from './stores.js';

/**
 * Run controls (FR-CTL-001..006, FR-ERR-003, FR-ERR-004, D81, D82).
 *
 * Everything here is bookkeeping: check the action is allowed, flip the gate, write the rows, emit
 * the events. Executing anything is the scheduler's, and arrives as two injected callbacks —
 * `driveRecordedRun` and `drivePartialRun`. That split is what lets a control be tested without a
 * provider, and it is also the honest description of the design: a control never runs a model, it
 * only changes what the thing that does is allowed to do next.
 *
 * Two rules from the decisions log shape the odd corners:
 *
 * - **D81**: a retry or a re-run re-opens a run that has already ended. FR-ERR-003's Retry button
 *   sits on a failed node, and by then the run has halted `failure`, so refusing would leave the
 *   button dead.
 * - **D82**: a retry and a re-run execute the run's *snapshot*, never the live workflow. Fixing a
 *   node and running it again is Start from this node, which is a new run (FR-ERR-008).
 */

/** The nodes the scheduler is asked to execute inside a run it has already recorded (D81). */
export interface PartialRunPlan {
  run: Run;
  /** The node runs this service created, already `READY` in the store. */
  nodeRuns: NodeRun[];
  /** Everything reachable after them runs again too (FR-ERR-004). */
  withDownstream: boolean;
}

/**
 * What the controls need of the event bus: persist-then-publish, nothing else. Narrower than
 * `EventBus` on purpose — the seq the log gives back is of no interest here, and a test bus that
 * only collects frames satisfies this.
 */
export interface ControlEventSink {
  emit(event: EmittedEvent): Promise<unknown>;
}

export interface RunControlsDeps {
  runs: ControlRunStore;
  nodeRuns: ControlNodeRunStore;
  bus: ControlEventSink;
  gates: RunGateRegistry;

  /**
   * Pre-flights and drives a run row this service has already recorded — the second half of
   * `beginRun` (FR-CTL-004). Resolves as soon as the run is under way (`RUNNING`, or `BLOCKED` by
   * pre-flight), never at its end, so `POST /runs/:id/restart` can answer while it is still going.
   */
  driveRecordedRun: (run: Run) => Promise<Run>;

  /**
   * Re-opens a finished run and drives the node runs in the plan, plus their downstream when the
   * plan says so (D81). Resolves once the run is going again.
   */
  drivePartialRun: (plan: PartialRunPlan) => Promise<Run>;

  /**
   * The envelopes a node would receive from the **latest** upstream outputs in this run — what a
   * re-run executes on (FR-CTL-005). Absent means the node re-runs with no reads, which is right
   * for an Input node and wrong for anything else, so the scheduler supplies it.
   */
  envelopesFor?: (run: Run, nodeId: Id) => Promise<Envelope[]>;

  logger?: Logger;
  now?: () => string;
  nextId?: () => string;
}

export interface RunControls {
  /** FR-CTL-001. Running nodes finish; nothing new starts; READY node runs become PAUSED. */
  pause(runId: Id): Promise<Run>;
  /** FR-CTL-002. PAUSED node runs go back to READY and dispatch continues. */
  resume(runId: Id): Promise<Run>;
  /** FR-CTL-003. Aborts every in-flight call, STOPs the nodes, halts the run `stopped`. */
  stop(runId: Id): Promise<Run>;
  /** FR-CTL-004. A new run on the same snapshot and inputs, with `restartedFromRunId`. */
  restart(runId: Id): Promise<Run>;
  /** FR-CTL-005. One node, on the latest upstream outputs, as a new node run. */
  rerunNode(runId: Id, nodeId: Id): Promise<NodeRun>;
  /** FR-ERR-003 / FR-ERR-004. A new node run at attempt + 1 with identical inputs. */
  retryNodeRun(nodeRunId: Id, request: RetryRequest): Promise<NodeRun>;
  /** FR-CTL-006. The run with `allowedActions` filled in. */
  get(runId: Id): Promise<Run>;
}

/** Node runs a pause turns into PAUSED: dispatched, but not yet doing anything (Arch §19.1). */
const PAUSABLE: ReadonlySet<NodeState> = new Set<NodeState>(['READY']);

/** Node runs a stop turns into STOPPED (R3 §4 item 1: RUNNING, READY and PAUSED alike). */
const STOPPABLE: ReadonlySet<NodeState> = new Set<NodeState>([
  'RUNNING',
  'READY',
  'PAUSED',
  'WAITING',
]);

export function createRunControls(deps: RunControlsDeps): RunControls {
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  async function load(runId: Id): Promise<Run> {
    const run = await deps.runs.get(runId);
    if (run === null) throw notFound(`run ${runId}`);
    return run;
  }

  /** Patch the run and always rewrite `allowedActions` from the status it ends up with (D76). */
  async function patchRun(
    run: Run,
    patch: Parameters<ControlRunStore['update']>[1],
  ): Promise<Run> {
    const status = patch.status ?? run.status;
    const updated = await deps.runs.update(run.id, {
      ...patch,
      allowedActions: allowedRunActions(status),
    });
    if (updated !== null) return withAllowedActions(updated);

    // A store that answered `null` has no row to return; the patch applied to what was read is
    // still the truth about the run. `pausedAt: null` means "clear it", so it is removed, not kept.
    const { pausedAt, ...rest } = patch;
    const fallback: Run = { ...run, ...rest, status };
    if (pausedAt === null) delete fallback.pausedAt;
    else if (pausedAt !== undefined) fallback.pausedAt = pausedAt;
    return withAllowedActions(fallback);
  }

  async function emitNodeState(run: Run, nodeRun: NodeRun, status: NodeState): Promise<void> {
    await deps.bus.emit({
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
      },
    });
  }

  /** Move every node run of this run whose state is in `from` to `to`, and announce each one. */
  async function moveNodeRuns(
    run: Run,
    from: ReadonlySet<NodeState>,
    to: NodeState,
    options: { endedAt?: boolean } = {},
  ): Promise<NodeRun[]> {
    const moved: NodeRun[] = [];

    for (const nodeRun of await deps.nodeRuns.listByRun(run.id)) {
      if (!from.has(nodeRun.status)) continue;

      const at = now();
      const updated = await deps.nodeRuns.update(nodeRun.id, {
        status: to,
        ...(options.endedAt === true ? { endedAt: at } : {}),
      });
      const row = updated ?? { ...nodeRun, status: to };
      await emitNodeState(run, row, to);
      moved.push(row);
    }

    return moved;
  }

  /** The attempt a new node run for this node should carry: one past the highest already recorded. */
  function nextAttempt(rows: readonly NodeRun[], nodeId: Id, iteration: number): number {
    const attempts = rows
      .filter((row) => row.nodeId === nodeId && row.iteration === iteration)
      .map((row) => row.attempt);
    return attempts.length === 0 ? 1 : Math.max(...attempts) + 1;
  }

  const controls: RunControls = {
    async get(runId) {
      return withAllowedActions(await load(runId));
    },

    async pause(runId) {
      const run = await load(runId);
      assertRunAction(run, 'pause');

      // The gate first: the point of pausing is that nothing new starts, and a node dispatched
      // between the row write and the flag would make the row a lie.
      deps.gates.get(runId)?.pause();

      const pausedAt = now();
      const paused = await patchRun(run, { status: 'PAUSED', pausedAt });

      // READY means "dispatched, waiting for its provider slot" (D66). Those go to PAUSED;
      // RUNNING nodes are left to finish, which is what FR-CTL-001 asks for.
      await moveNodeRuns(paused, PAUSABLE, 'PAUSED');

      await deps.bus.emit({
        type: 'run.paused',
        workflowId: run.workflowId,
        runId: run.id,
        payload: { runId: run.id },
      });

      deps.logger?.info({ subsystem: 'runs', runId }, 'run paused');
      return paused;
    },

    async resume(runId) {
      const run = await load(runId);
      assertRunAction(run, 'resume');

      const resumed = await patchRun(run, { status: 'RUNNING', pausedAt: null });
      await moveNodeRuns(resumed, new Set<NodeState>(['PAUSED']), 'READY');

      // The gate last: every row says READY before the scheduler is allowed to dispatch again.
      deps.gates.get(runId)?.resume();

      await deps.bus.emit({
        type: 'run.resumed',
        workflowId: run.workflowId,
        runId: run.id,
        payload: { runId: run.id },
      });

      deps.logger?.info({ subsystem: 'runs', runId }, 'run resumed');
      return resumed;
    },

    async stop(runId) {
      const run = await load(runId);
      assertRunAction(run, 'stop');

      // Abort first and synchronously: FR-CTL-003 measures the time to the provider stream
      // closing, and every millisecond spent writing rows before this is on that clock.
      const gate = deps.gates.get(runId);
      gate?.stop();

      await moveNodeRuns(run, STOPPABLE, 'STOPPED', { endedAt: true });

      // A stopped run still spent what it spent (FR-ERR-007, TC-OBS-002): its totals are the sum of
      // its node runs, every attempt included, not the zeros it was created with. The scheduler's
      // own end-of-run write — the one that totals a run — is skipped on a stop, so it is taken here.
      const totals = sumUsage((await deps.nodeRuns.listByRun(run.id)).map((row) => row.usage));

      const endedAt = now();
      const halted = await patchRun(run, {
        status: 'HALTED',
        haltReason: 'stopped',
        totals,
        endedAt,
        durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)),
      });

      await deps.bus.emit({
        type: 'run.completed',
        workflowId: run.workflowId,
        runId: run.id,
        payload: {
          runId: run.id,
          status: 'HALTED',
          haltReason: 'stopped',
          totals: halted.totals,
        },
      });

      deps.logger?.info({ subsystem: 'runs', runId }, 'run stopped');
      return halted;
    },

    async restart(runId) {
      const source = await load(runId);
      assertRunAction(source, 'restart');

      // BR-04: the same snapshot, not a fresh one off the live tables. A restart re-runs what the
      // original run ran, which is the only reading of FR-CTL-004 that survives an edited graph.
      const created = await deps.runs.create({
        id: nextId(),
        workflowId: source.workflowId,
        projectId: source.projectId,
        status: 'PREFLIGHT',
        snapshot: source.snapshot,
        inputs: source.inputs,
        preflightIssues: [],
        totals: zeroUsage(),
        startedAt: now(),
        allowedActions: allowedRunActions('PREFLIGHT'),
        restartedFromRunId: source.id,
      });

      const started = await deps.driveRecordedRun(created);
      deps.logger?.info(
        { subsystem: 'runs', runId: started.id, restartedFromRunId: source.id },
        'run restarted',
      );
      return withAllowedActions(started);
    },

    async rerunNode(runId, nodeId) {
      const run = await load(runId);
      if (!run.snapshot.nodes.some((node) => node.id === nodeId)) {
        throw notFound(`node ${nodeId} in run ${runId}`);
      }

      const rows = await deps.nodeRuns.listByRun(runId);
      const previous = rows.filter((row) => row.nodeId === nodeId);
      // The iteration a re-run belongs to is the latest one recorded: a re-run is not a new loop
      // iteration, it is another go at the same one.
      const iteration = previous.length === 0 ? 1 : Math.max(...previous.map((row) => row.iteration));

      // FR-CTL-005: the *latest* upstream outputs, rebuilt — not the envelopes the old node run
      // was given, which is what a retry uses instead (FR-ERR-003).
      const envelopes = (await deps.envelopesFor?.(run, nodeId)) ?? [];

      const nodeRun = await deps.nodeRuns.create({
        id: nextId(),
        runId,
        nodeId,
        iteration,
        // A new attempt number rather than 1, so (node, iteration, attempt) stays unique and the
        // inspector can list the re-run beside what it replaced (D95).
        attempt: nextAttempt(rows, nodeId, iteration),
        status: 'READY',
        inputEnvelopes: envelopes,
        usage: zeroUsage(),
        verdicts: [],
        toolCalls: [],
        approvals: [],
      });

      await reopen(run, { run, nodeRuns: [nodeRun], withDownstream: false });
      return nodeRun;
    },

    async retryNodeRun(nodeRunId, request) {
      const failed = await deps.nodeRuns.get(nodeRunId);
      if (failed === null) throw notFound(`node run ${nodeRunId}`);

      const run = await load(failed.runId);
      const rows = await deps.nodeRuns.listByRun(run.id);

      // FR-ERR-003: identical inputs. The envelopes the failed attempt was handed are copied
      // across verbatim — a retry that rebuilt them would not be the same attempt again.
      const retry = await deps.nodeRuns.create({
        id: nextId(),
        runId: run.id,
        nodeId: failed.nodeId,
        iteration: failed.iteration,
        attempt: failed.attempt + 1,
        status: 'READY',
        inputEnvelopes: failed.inputEnvelopes,
        usage: zeroUsage(),
        verdicts: [],
        toolCalls: [],
        approvals: [],
      });

      // FR-ERR-004: everything reachable after it re-executes. The BLOCKED rows it left behind are
      // cleared back to IDLE first, so the scheduler sees nodes waiting for input rather than a
      // finished graph.
      if (request.withDownstream) {
        const downstream = downstreamOf(failed.nodeId, run.snapshot.edges);
        for (const row of rows) {
          if (!downstream.has(row.nodeId)) continue;
          if (row.status !== 'BLOCKED') continue;
          const cleared = await deps.nodeRuns.update(row.id, { status: 'IDLE' });
          await emitNodeState(run, cleared ?? row, 'IDLE');
        }
      }

      await reopen(run, {
        run,
        nodeRuns: [retry],
        withDownstream: request.withDownstream,
      });
      return retry;
    },
  };

  /**
   * D81: a retry or a re-run on a finished run puts it back to RUNNING on its own snapshot, and it
   * ends again with a second `run.completed`. `allowedActions` follows the status as it changes.
   */
  async function reopen(run: Run, plan: PartialRunPlan): Promise<void> {
    const reopened =
      run.status === 'RUNNING' || run.status === 'PAUSED'
        ? run
        : await patchRun(run, { status: 'RUNNING' });

    await deps.drivePartialRun({ ...plan, run: reopened });
  }

  return controls;
}
