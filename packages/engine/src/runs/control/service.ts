import {
  allowedRunActions,
  CONTINUABLE_HALT_REASONS,
  interruptedNodeRuns,
  zeroUsage,
  type DayTotals,
  type Envelope,
  type Id,
  type NodeRun,
  type NodeState,
  type RetryRequest,
  type Run,
} from '@ace/contracts';

import type { ApprovalService } from '../../approvals/index.js';
import type { DomainRegistry } from '../../domain/registry.js';
import type { RunDomain } from '../../domain/run-domain.js';
import type { EmittedEvent } from '../../events/index.js';
import { HttpError, notFound, notImplemented } from '../../gateway/errors.js';
import { asDelivered } from '../../envelopes/index.js';
import { newId } from '../../ids.js';
import type { Logger } from '../../logging/index.js';
import type { UsageService } from '../../usage/index.js';
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
   * PG-5.4: pre-flights and drives a replay row this service recorded — every provider call
   * answered from the source run's recorded outputs. Resolves once it is under way. Absent,
   * `POST /runs/:id/replay` answers `not_implemented`.
   */
  driveReplayRun?: (run: Run) => Promise<Run>;

  /**
   * The envelopes a node would receive from the **latest** upstream outputs in this run — what a
   * re-run executes on (FR-CTL-005). Absent means the node re-runs with no reads, which is right
   * for an Input node and wrong for anything else, so the scheduler supplies it.
   */
  envelopesFor?: (run: Run, nodeId: Id) => Promise<Envelope[]>;

  /**
   * Rejects what is still waiting on a stopped run (FR-GRD-013, D111, D-054). A Stop cancels a
   * WAITING node's approval itself, before it answers, so the card is gone by the time the client
   * reads the halted run and a late Approve finds nothing to decide (D120's 404). Absent, the
   * scheduler still rejects them once the drive has unwound.
   */
  approvals?: Pick<ApprovalService, 'cancelPending'>;

  /**
   * The day's totals a Stop announces with `usage.updated` before its `run.completed` (round 5 §2.8,
   * FR-OBS-002, 13a review m5): a stopped run spent money too, and the top bar must count it.
   * Absent, a Stop carries no day totals.
   */
  usage?: Pick<UsageService, 'dayTotals'>;

  /**
   * Domain (D309): a Stop drops what is still waiting for a turn before it says the run has ended.
   * Absent, a run has no messages to drop.
   */
  domains?: DomainRegistry;

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
  /**
   * PG-5.4 (FR-GIT-007, Arch §20.2). A new run on the same snapshot and inputs, `replayOf` set,
   * answered from this run's recorded node outputs with zero provider calls. Only a finished run
   * (COMPLETE or HALTED) can be replayed; anything else answers 409 `invalid_run_state`.
   */
  replay?(runId: Id): Promise<Run>;
  /** FR-CTL-005. One node, on the latest upstream outputs, as a new node run. */
  rerunNode(runId: Id, nodeId: Id): Promise<NodeRun>;
  /** FR-ERR-003 / FR-ERR-004. A new node run at attempt + 1 with identical inputs. */
  retryNodeRun(nodeRunId: Id, request: RetryRequest): Promise<NodeRun>;
  /**
   * D388. A run cut off — HALTED `stopped`, `shutdown` or `crash` — carries on: every node run the
   * halt interrupted gets a retry (attempt + 1, the inputs it was delivered), what they feed runs
   * after them, and nothing that finished runs again. One drive, one reopen. 409 `invalid_run_state`
   * for any other run, 409 `nothing_to_continue` when nothing was cut off.
   */
  continueRun(runId: Id): Promise<Run>;
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
  async function patchRun(run: Run, patch: Parameters<ControlRunStore['update']>[1]): Promise<Run> {
    const status = patch.status ?? run.status;
    const blockedReason =
      patch.blockedReason === null ? undefined : (patch.blockedReason ?? run.blockedReason);
    const updated = await deps.runs.update(run.id, {
      ...patch,
      // D305, D323: why it is blocked, and whether it stays open, decide its controls too.
      allowedActions: allowedRunActions(status, { blockedReason, stayOpen: run.domain?.stayOpen }),
    });
    if (updated !== null) return withAllowedActions(updated);

    // A store that answered `null` has no row to return; the patch applied to what was read is
    // still the truth about the run. `pausedAt: null` means "clear it", so it is removed, not kept.
    const { pausedAt, blockedReason: reason, ...rest } = patch;
    const fallback: Run = { ...run, ...rest, status };
    if (pausedAt === null) delete fallback.pausedAt;
    else if (pausedAt !== undefined) fallback.pausedAt = pausedAt;
    if (reason === null) delete fallback.blockedReason;
    else if (reason !== undefined) fallback.blockedReason = reason;
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

  /**
   * The UTC day's totals across every run, when a usage service is wired (FR-OBS-002). Best effort:
   * a Stop must land whatever a read model does (FR-CTL-003), so a failure is logged and skipped.
   */
  async function dayTotalsAt(runId: Id, at: string): Promise<DayTotals | undefined> {
    if (deps.usage === undefined) return undefined;
    try {
      return await deps.usage.dayTotals(at.slice(0, 10));
    } catch (error) {
      deps.logger?.warn({ subsystem: 'runs', runId, err: error }, 'could not read the day totals');
      return undefined;
    }
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

      // D305: a run BLOCKED mid-run leaves BLOCKED the same way, and loses its reason.
      const resumed = await patchRun(run, {
        status: 'RUNNING',
        pausedAt: null,
        ...(run.blockedReason === undefined ? {} : { blockedReason: null }),
      });
      await moveNodeRuns(resumed, new Set<NodeState>(['PAUSED']), 'READY');

      // D310: resuming past the loop guard resets the held pairs and forwards what it held.
      if (run.blockedReason === 'LOOP_GUARD') await deps.domains?.get(runId)?.releaseLoopGuard();

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

      /*
       * D-054: nobody is going to answer an approval on a stopped run. The abort above has already
       * ended the WAITING node's wait; rejecting the request now — before the rows, and before the
       * run is written HALTED — takes the card away and leaves nothing for a late Approve to
       * decide, so it cannot move a STOPPED row back to RUNNING. Best effort: the scheduler rejects
       * anything left once the drive unwinds, and the stop itself must still land (FR-CTL-003).
       */
      try {
        await deps.approvals?.cancelPending(runId, 'The run was stopped before this was decided.');
      } catch (error) {
        deps.logger?.warn(
          { subsystem: 'runs', runId, err: error },
          'could not cancel the approvals of a stopped run',
        );
      }

      await moveNodeRuns(run, STOPPABLE, 'STOPPED', { endedAt: true });

      // D309: what was still waiting for a turn never got one — DROPPED, before the end is said.
      try {
        await deps.domains?.get(runId)?.close();
      } catch (error) {
        deps.logger?.warn(
          { subsystem: 'runs', runId, err: error },
          'could not drop the pending messages of a stopped run',
        );
      }

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

      // Round 5 §2.8 (FR-OBS-002): the day's totals, for the top bar, ahead of `run.completed`.
      const dayTotals = await dayTotalsAt(run.id, endedAt);
      if (dayTotals !== undefined) {
        await deps.bus.emit({
          type: 'usage.updated',
          workflowId: run.workflowId,
          runId: run.id,
          payload: { runId: run.id, totals: halted.totals, dayTotals },
        });
      }

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
      let source = await load(runId);
      // D360: a Domain run that is still open is ended first — its turns cut short, what was
      // pending dropped, exactly as End does — and then restarted, so two drives never share it.
      const open = liveDomainOf(source);
      if (open !== undefined) {
        open.requestEnd();
        if (source.status === 'BLOCKED') deps.gates.get(runId)?.resume();
        source = withAllowedActions(await open.finished());
      } else if (isLive(source) && source.domain?.stayOpen === true) {
        // Open, but no drive here holds it (it is being carried on, or ending): nothing safe to end.
        throw liveRefusal(source, 'restart');
      }
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
        // D312: the same goal and Domain settings, so the restart is the same run again.
        ...(source.domain === undefined ? {} : { domain: source.domain }),
        ...(source.goal === undefined ? {} : { goal: source.goal }),
      });

      const started = await deps.driveRecordedRun(created);
      deps.logger?.info(
        { subsystem: 'runs', runId: started.id, restartedFromRunId: source.id },
        'run restarted',
      );
      return withAllowedActions(started);
    },

    async replay(runId) {
      const source = await load(runId);
      // Only a finished run has a whole recording; a live one is still writing it, and a run
      // blocked at pre-flight never called anything to record.
      if (source.status !== 'COMPLETE' && source.status !== 'HALTED') {
        throw new HttpError(
          'workflow',
          'invalid_run_state',
          `Only a finished run can be replayed — this one is ${source.status}.`,
          { runId: source.id, status: source.status },
        );
      }
      if (deps.driveReplayRun === undefined) throw notImplemented('run replay');

      // BR-04: the source's snapshot and inputs. No Domain settings: a replay never stays open and
      // has no Brain to consult — it only plays back what was recorded.
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
        replayOf: source.id,
        ...(source.goal === undefined ? {} : { goal: source.goal }),
      });

      const started = await deps.driveReplayRun(created);
      deps.logger?.info(
        { subsystem: 'runs', runId: started.id, replayOf: source.id },
        'run replayed',
      );
      return withAllowedActions(started);
    },

    async rerunNode(runId, nodeId) {
      const run = await load(runId);
      // D360: on an open Domain run the drive already running takes the re-run as a turn.
      const open = liveDomainOf(run);
      if (open === undefined) assertNotLive(run, 'rerun');
      if (!run.snapshot.nodes.some((node) => node.id === nodeId)) {
        throw notFound(`node ${nodeId} in run ${runId}`);
      }
      if (open !== undefined) assertNodeFree(run, open, nodeId, 'rerun');

      const rows = await deps.nodeRuns.listByRun(runId);
      const previous = rows.filter((row) => row.nodeId === nodeId);
      // The iteration a re-run belongs to is the latest one recorded: a re-run is not a new loop
      // iteration, it is another go at the same one.
      const iteration =
        previous.length === 0 ? 1 : Math.max(...previous.map((row) => row.iteration));

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

      if (open !== undefined) {
        open.planTurn({ nodeRun, withDownstream: false });
        return nodeRun;
      }
      await reopen(run, { run, nodeRuns: [nodeRun], withDownstream: false });
      return nodeRun;
    },

    async retryNodeRun(nodeRunId, request) {
      const failed = await deps.nodeRuns.get(nodeRunId);
      if (failed === null) throw notFound(`node run ${nodeRunId}`);

      const run = await load(failed.runId);
      // D360: Retry of a failed turn on an open Domain run is a turn of the drive running it.
      const open = liveDomainOf(run);
      if (open === undefined) assertNotLive(run, 'retry');
      else assertNodeFree(run, open, failed.nodeId, 'retry');
      const rows = await deps.nodeRuns.listByRun(run.id);

      // FR-ERR-003: identical inputs. The envelopes the failed attempt was *delivered* are copied
      // across — never rebuilt, which would not be the same attempt again. Its row stores what it
      // read, context placed; that comes off and the trust is the source's again (13b fix I1,
      // BR-13), so the retry's own context step builds it afresh and a failed step leaves no stale
      // chunk on this row.
      const retry = await deps.nodeRuns.create({
        id: nextId(),
        runId: run.id,
        nodeId: failed.nodeId,
        iteration: failed.iteration,
        attempt: failed.attempt + 1,
        status: 'READY',
        inputEnvelopes: asDelivered(failed.inputEnvelopes, run.snapshot.nodes),
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

      if (open !== undefined) {
        open.planTurn({ nodeRun: retry, withDownstream: request.withDownstream });
        return retry;
      }
      await reopen(run, {
        run,
        nodeRuns: [retry],
        withDownstream: request.withDownstream,
      });
      return retry;
    },

    async continueRun(runId) {
      const run = await load(runId);
      // D388: only a run that was cut off carries on. A `failure` halt is a Retry of the node that
      // failed, a `budget_exceeded` one would only halt again, and a run still going (an open Domain
      // run included, D323/D360) already has a drive — a HALTED run never does.
      if (!wasCutOff(run)) throw continueRefusal(run);

      const rows = await deps.nodeRuns.listByRun(run.id);
      const cut = onePerNode(interruptedNodeRuns(rows));
      if (cut.length === 0) {
        throw new HttpError(
          'workflow',
          'nothing_to_continue',
          'Nothing in this run was cut off — retry a failed node or restart the run.',
          { runId: run.id, status: run.status, haltReason: run.haltReason },
        );
      }

      // FR-ERR-003 for each of them, exactly as `retryNodeRun`: attempt + 1, READY, the envelopes
      // the cut-off attempt was delivered (never rebuilt), and nothing of its own yet.
      const retries: NodeRun[] = [];
      for (const interrupted of cut) {
        retries.push(
          await deps.nodeRuns.create({
            id: nextId(),
            runId: run.id,
            nodeId: interrupted.nodeId,
            iteration: interrupted.iteration,
            attempt: interrupted.attempt + 1,
            status: 'READY',
            inputEnvelopes: asDelivered(interrupted.inputEnvelopes, run.snapshot.nodes),
            usage: zeroUsage(),
            verdicts: [],
            toolCalls: [],
            approvals: [],
          }),
        );
      }

      // FR-ERR-004 as `retryNodeRun({ withDownstream: true })`: a BLOCKED row after any of them goes
      // back to IDLE, so the drive sees a node waiting for input. A node being continued keeps its
      // own rows as they are — its retry above is what runs.
      const continued = new Set(cut.map((row) => row.nodeId));
      const downstream = new Set<Id>();
      for (const nodeId of continued) {
        for (const reached of downstreamOf(nodeId, run.snapshot.edges)) downstream.add(reached);
      }
      for (const row of rows) {
        if (row.status !== 'BLOCKED' || continued.has(row.nodeId)) continue;
        if (!downstream.has(row.nodeId)) continue;
        const cleared = await deps.nodeRuns.update(row.id, { status: 'IDLE' });
        await emitNodeState(run, cleared ?? row, 'IDLE');
      }

      // One reopen and one drive for all of them (D81): a reopen per node would make the run
      // RUNNING after the first, and a second drive beside the first (D309).
      const reopened = await reopen(run, { run, nodeRuns: retries, withDownstream: true });
      deps.logger?.info(
        { subsystem: 'runs', runId, nodeRunIds: retries.map((row) => row.id) },
        'run continued',
      );
      return reopened;
    },
  };

  /** D388: HALTED by a stop, a shutdown or a crash — cut off, rather than failed or over budget. */
  function wasCutOff(run: Run): boolean {
    return (
      run.status === 'HALTED' &&
      (CONTINUABLE_HALT_REASONS as readonly string[]).includes(run.haltReason ?? '')
    );
  }

  function continueRefusal(run: Run): HttpError {
    const state =
      run.status === 'HALTED' ? `halted (${run.haltReason ?? 'no reason'})` : `is ${run.status}`;
    return new HttpError(
      'workflow',
      'invalid_run_state',
      `A run that ${state} cannot be continued — only a run that was stopped, shut down or cut off by a crash can.`,
      {
        runId: run.id,
        status: run.status,
        ...(run.haltReason === undefined ? {} : { haltReason: run.haltReason }),
        allowedActions: withAllowedActions(run).allowedActions,
      },
    );
  }

  /**
   * The drive plans one node run per node, so a node cut off in two iterations — which a single
   * drive never leaves — carries on from the later one rather than leaving a READY row nobody runs.
   */
  function onePerNode(rows: readonly NodeRun[]): NodeRun[] {
    const byNode = new Map<Id, NodeRun>();
    for (const row of rows) {
      const seen = byNode.get(row.nodeId);
      if (seen === undefined || row.iteration > seen.iteration) byNode.set(row.nodeId, row);
    }
    return [...byNode.values()];
  }

  /**
   * D309: a re-run or a retry of a run that is still going would start a second drive beside the
   * first — two schedulers on one run. Refused (409); a node in a live run is addressed with a
   * message instead, which takes a turn in the drive already running.
   */
  function assertNotLive(run: Run, what: 'rerun' | 'retry'): void {
    if (!isLive(run)) return;
    throw liveRefusal(run, what);
  }

  function isLive(run: Run): boolean {
    return (
      run.status === 'RUNNING' ||
      run.status === 'PAUSED' ||
      (run.status === 'BLOCKED' && run.blockedReason !== undefined)
    );
  }

  function liveRefusal(run: Run, what: 'rerun' | 'retry' | 'restart'): HttpError {
    const action = what === 'restart' ? 'be restarted' : `${what} a node`;
    return new HttpError(
      'workflow',
      'invalid_run_state',
      `A run that is ${run.status} cannot ${action} — it is still going; send that node a message instead.`,
      { runId: run.id, status: run.status, allowedActions: withAllowedActions(run).allowedActions },
    );
  }

  /**
   * D360 (amends D323): an open Domain run whose drive is in this process and has not been told to
   * end. Its controls go to that drive — a retry or a re-run becomes one of its turns, a restart
   * ends it first — rather than a second drive beside it (D309). Any other live run is refused.
   */
  function liveDomainOf(run: Run): RunDomain | undefined {
    if (!isLive(run) || run.domain?.stayOpen !== true) return undefined;
    const domain = deps.domains?.get(run.id);
    if (domain === undefined || domain.isClosed() || domain.endRequested()) return undefined;
    return domain;
  }

  /** A node with a turn in flight takes no second one beside it (D309): 409, as before. */
  function assertNodeFree(run: Run, domain: RunDomain, nodeId: Id, what: 'rerun' | 'retry'): void {
    const state = domain.nodeStates()[nodeId];
    const busy =
      domain.hasTurn(nodeId) || state === 'RUNNING' || state === 'READY' || state === 'WAITING';
    if (!busy) return;
    throw new HttpError(
      'workflow',
      'invalid_run_state',
      `This node is still working in the run — it cannot ${what} until its turn ends.`,
      { runId: run.id, nodeId, status: run.status },
    );
  }

  /**
   * D81: a retry or a re-run on a finished run puts it back to RUNNING on its own snapshot, and it
   * ends again with a second `run.completed`. `allowedActions` follows the status as it changes.
   * Answers the run as re-opened, which is what a continue hands back (D388).
   */
  async function reopen(run: Run, plan: PartialRunPlan): Promise<Run> {
    const reopened =
      run.status === 'RUNNING' || run.status === 'PAUSED'
        ? run
        : await patchRun(run, { status: 'RUNNING' });

    await deps.drivePartialRun({ ...plan, run: reopened });
    return reopened;
  }

  return controls;
}
