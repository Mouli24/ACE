import {
  allowedRunActions,
  isAgentic,
  type AgentConfig,
  type Id,
  type NodeError,
  type NodeState,
  type Run,
} from '@ace/contracts';

import type { ApprovalService } from '../approvals/index.js';
import type { EventBus } from '../events/index.js';
import type { Logger } from '../logging/index.js';
import type { Repository, Scope } from '../ports/index.js';
import { sumUsage } from './cost.js';
import { toSummary } from './summary.js';

/**
 * What happens to a run when the engine stops (FR-SYS-008) and when it starts again
 * (FR-SYS-009).
 *
 * The distinction matters to the person reading the history afterwards: `shutdown` means someone
 * stopped the engine while this was running, `crash` means the engine died without getting the
 * chance to say so. Both are halts, and neither is a failure of the workflow.
 */

export interface LifecycleDeps {
  repository: Repository;
  scope: Scope;
  bus: EventBus;
  logger: Logger;
  now?: () => string;
  /**
   * Rejects the approvals still pending on a run this halts (FR-GRD-013, D-061). The process that
   * was suspended on them is gone, so nobody can answer them; left pending, the card stays on a
   * HALTED run and an Approve moves the STOPPED node back to RUNNING. Absent, nothing is rejected.
   */
  approvals?: Pick<ApprovalService, 'cancelPending'>;
  /**
   * D323: a run started from Domain stays open, so a restart carries it on rather than halting it.
   * Absent, every stranded run is halted `crash` as before. [audit E-7] A clean shutdown leaves
   * such a run open too (`haltActiveRuns`), for the next start to carry on.
   */
  keepOpen?: (run: Run) => boolean;
}

export interface RecoveryResult {
  /** The runs halted `crash`. */
  runs: Id[];
  /** The node runs a halt stopped, or a re-opened run's turns ended FAILED `crash`. */
  nodeRuns: Id[];
  /** D323: runs kept open — the caller drives each again (`RunService.resumeOpenRun`). */
  reopened: Run[];
}

/** What a turn the engine died in the middle of records (D323): it did not finish, and why. */
const crashedTurn = {
  kind: 'workflow' as const,
  code: 'crash',
  message: 'The engine stopped while this turn was running, so it did not finish.',
  retryable: false,
};

/**
 * D379: what an agentic step records when the engine restarted under it. The step may have
 * changed files and started commands, so it is BLOCKED with the reason, not quietly STOPPED.
 * (`workflow` is the error kind the restart belongs to: there is no `run` kind.)
 */
const RESTART_NOTE = 'Background commands from this run were stopped.';
const agenticRestartError = (waiting: boolean): NodeError => ({
  kind: 'workflow',
  code: waiting ? 'approval_lost' : 'engine_restarted',
  message: waiting
    ? `The approval was lost when the engine restarted. ${RESTART_NOTE}`
    : `The engine restarted mid-step. ${RESTART_NOTE}`,
  retryable: true,
});

/** The ids of the run's agentic nodes, read from its snapshot (the config the run executed). */
function agenticNodeIds(run: Run): ReadonlySet<Id> {
  const ids = new Set<Id>();
  for (const node of run.snapshot.nodes) {
    if (node.kind === 'agent' && isAgentic(node.config as AgentConfig)) ids.add(node.id);
  }
  return ids;
}

/**
 * Node runs a halt leaves with nothing to run them: going, queued, waiting on a person, or held by a
 * pause (FR-SYS-009). [audit E-6] PAUSED is one of them — a paused run that died kept its PAUSED
 * rows, which Continue (D388) does not read as cut off, so the nodes it held never ran again.
 */
const UNFINISHED: ReadonlySet<NodeState> = new Set<NodeState>([
  'RUNNING',
  'READY',
  'WAITING',
  'PAUSED',
]);

/** Mark one run halted, and announce it so a watching client stops waiting. */
async function halt(
  deps: LifecycleDeps,
  run: Run,
  haltReason: 'shutdown' | 'crash',
  endedAt: string,
): Promise<void> {
  /*
   * [audit E-6] The row says what a HALTED run allows (FR-CTL-006, D76) — it kept the RUNNING
   * run's `[pause, stop]`, or a paused one's `[resume, stop]` — and what it spent: the sum of its
   * node runs (TC-OBS-002), because the drive that would have totalled it is gone.
   */
  const totals = sumUsage(
    (await deps.repository.nodeRuns.listByRun(deps.scope, run.id)).map((row) => row.usage),
  );
  await deps.repository.runs.update(deps.scope, run.id, {
    status: 'HALTED',
    haltReason,
    allowedActions: allowedRunActions('HALTED', { stayOpen: run.domain?.stayOpen }),
    totals,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)),
  });

  await deps.bus.emit({
    type: 'run.completed',
    workflowId: run.workflowId,
    runId: run.id,
    payload: { runId: run.id, status: 'HALTED', haltReason, totals },
  });

  // Nobody is left to answer an approval on a halted run (D111, D-061). Best effort: a card that
  // could not be rejected is worth a warning, not an engine that refuses to start or stop.
  try {
    await deps.approvals?.cancelPending(
      run.id,
      haltReason === 'crash'
        ? 'The engine stopped unexpectedly before this was decided.'
        : 'The engine was shut down before this was decided.',
    );
  } catch (error) {
    deps.logger.warn(
      { subsystem: 'runs', runId: run.id, err: error },
      'could not reject the approvals of a halted run',
    );
  }
}

/**
 * FR-SYS-009 / TC-SYS-010: on startup, a run the store still believes is going cannot be — this
 * process has only just begun. It is halted `crash`, and every node run still marked RUNNING is
 * STOPPED, because nothing is running it any more.
 *
 * Runs first, nodes second: if recovery itself dies half way, a run already marked HALTED with
 * some nodes still RUNNING is easier to read than the reverse.
 */
export async function recoverAfterCrash(deps: LifecycleDeps): Promise<RecoveryResult> {
  const endedAt = (deps.now ?? (() => new Date().toISOString()))();
  const stranded = await deps.repository.runs.listActive(deps.scope);
  const result: RecoveryResult = { runs: [], nodeRuns: [], reopened: [] };

  for (const run of stranded) {
    if (deps.keepOpen?.(run) === true) {
      // D323: the run carries on; only the turns that were in flight are over — FAILED `crash`.
      for (const nodeRun of await deps.repository.nodeRuns.listByRun(deps.scope, run.id)) {
        if (
          nodeRun.status !== 'RUNNING' &&
          nodeRun.status !== 'READY' &&
          nodeRun.status !== 'WAITING'
        ) {
          continue;
        }
        await deps.repository.nodeRuns.update(deps.scope, nodeRun.id, {
          status: 'FAILED',
          failureReason: 'RUN_FAILED',
          error: crashedTurn,
          endedAt,
        });
        await deps.bus.emit({
          type: 'node.error',
          workflowId: run.workflowId,
          runId: run.id,
          payload: {
            runId: run.id,
            nodeRunId: nodeRun.id,
            nodeId: nodeRun.nodeId,
            error: crashedTurn,
            failureReason: 'RUN_FAILED',
          },
        });
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
            status: 'FAILED',
            failureReason: 'RUN_FAILED',
          },
        });
        result.nodeRuns.push(nodeRun.id);
      }
      // The turns that were in flight are over, so nobody can answer their approvals either.
      try {
        await deps.approvals?.cancelPending(
          run.id,
          'The engine stopped unexpectedly before this was decided.',
        );
      } catch (error) {
        deps.logger.warn(
          { subsystem: 'runs', runId: run.id, err: error },
          'could not reject the approvals of a re-opened run',
        );
      }
      result.reopened.push(run);
      continue;
    }

    await halt(deps, run, 'crash', endedAt);
    result.runs.push(run.id);
    const agentic = agenticNodeIds(run);

    for (const nodeRun of await deps.repository.nodeRuns.listByRun(deps.scope, run.id)) {
      if (!UNFINISHED.has(nodeRun.status)) continue;

      // A READY or PAUSED step never started, so it changed nothing: it is STOPPED like any other.
      if (
        agentic.has(nodeRun.nodeId) &&
        (nodeRun.status === 'RUNNING' || nodeRun.status === 'WAITING')
      ) {
        // D379: an agentic step may have changed files or started commands; say why it ended.
        const error = agenticRestartError(nodeRun.status === 'WAITING');
        await deps.repository.nodeRuns.update(deps.scope, nodeRun.id, {
          status: 'BLOCKED',
          failureReason: 'BLOCKED',
          error,
          endedAt,
        });
        await deps.bus.emit({
          type: 'node.error',
          workflowId: run.workflowId,
          runId: run.id,
          payload: {
            runId: run.id,
            nodeRunId: nodeRun.id,
            nodeId: nodeRun.nodeId,
            error,
            failureReason: 'BLOCKED',
          },
        });
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
            status: 'BLOCKED',
            failureReason: 'BLOCKED',
          },
        });
        result.nodeRuns.push(nodeRun.id);
        continue;
      }

      await deps.repository.nodeRuns.update(deps.scope, nodeRun.id, {
        status: 'STOPPED',
        endedAt,
      });
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
          status: 'STOPPED',
        },
      });
      result.nodeRuns.push(nodeRun.id);
    }
  }

  if (result.reopened.length > 0) {
    deps.logger.warn(
      { subsystem: 'runs', runs: result.reopened.length },
      'carried on runs started from Domain that a previous process left open',
    );
  }

  if (result.runs.length > 0) {
    deps.logger.warn(
      { subsystem: 'runs', runs: result.runs.length, nodeRuns: result.nodeRuns.length },
      'halted runs that were still marked active from a previous process',
    );
  }

  return result;
}

/**
 * FR-SYS-008 / TC-SYS-009: the engine was asked to stop. Whatever is still going is halted
 * `shutdown` — the in-flight provider calls are aborted by the run service, and this is what
 * records the outcome. [audit E-7] A run `keepOpen` names (D323: started from Domain) is not
 * halted: the next start carries it on, as it does after a crash.
 */
export async function haltActiveRuns(deps: LifecycleDeps): Promise<Id[]> {
  const endedAt = (deps.now ?? (() => new Date().toISOString()))();
  const halted: Id[] = [];

  for (const run of await deps.repository.runs.listActive(deps.scope)) {
    if (deps.keepOpen?.(run) === true) continue;
    await halt(deps, run, 'shutdown', endedAt);
    halted.push(run.id);
  }

  return halted;
}

export { toSummary };
