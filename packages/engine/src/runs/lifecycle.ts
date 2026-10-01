import type { Id, Run } from '@ace/contracts';

import type { ApprovalService } from '../approvals/index.js';
import type { EventBus } from '../events/index.js';
import type { Logger } from '../logging/index.js';
import type { Repository, Scope } from '../ports/index.js';
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
}

export interface RecoveryResult {
  runs: Id[];
  nodeRuns: Id[];
}

/** Mark one run halted, and announce it so a watching client stops waiting. */
async function halt(
  deps: LifecycleDeps,
  run: Run,
  haltReason: 'shutdown' | 'crash',
  endedAt: string,
): Promise<void> {
  await deps.repository.runs.update(deps.scope, run.id, {
    status: 'HALTED',
    haltReason,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)),
  });

  await deps.bus.emit({
    type: 'run.completed',
    workflowId: run.workflowId,
    runId: run.id,
    payload: { runId: run.id, status: 'HALTED', haltReason, totals: run.totals },
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
  const result: RecoveryResult = { runs: [], nodeRuns: [] };

  for (const run of stranded) {
    await halt(deps, run, 'crash', endedAt);
    result.runs.push(run.id);

    for (const nodeRun of await deps.repository.nodeRuns.listByRun(deps.scope, run.id)) {
      if (nodeRun.status !== 'RUNNING' && nodeRun.status !== 'READY' && nodeRun.status !== 'WAITING') {
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
 * records the outcome.
 */
export async function haltActiveRuns(deps: LifecycleDeps): Promise<Id[]> {
  const endedAt = (deps.now ?? (() => new Date().toISOString()))();
  const halted: Id[] = [];

  for (const run of await deps.repository.runs.listActive(deps.scope)) {
    await halt(deps, run, 'shutdown', endedAt);
    halted.push(run.id);
  }

  return halted;
}

export { toSummary };
