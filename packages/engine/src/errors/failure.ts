import type { FailureReason, NodeRun, NodeState, NodeError } from '@ace/contracts';

/**
 * What an error kind does to a node run, and how a run counts what happened (Arch §28, BR-03,
 * BR-12, FR-ERR-006, FR-ERR-007).
 *
 * BR-03 is the whole reason this is a table and not an `if`: `RUN_FAILED`, `CONTRACT_VIOLATION`,
 * `GUARDRAIL_VIOLATION` and `BLOCKED` must never be merged, and the only way to keep four
 * distinctions straight is to write them down once.
 */

/** Arch §28 → BR-03: the failure reason a node run records for this error. */
export function failureReasonFor(error: NodeError): FailureReason {
  if (error.kind === 'guardrail') return 'GUARDRAIL_VIOLATION';
  if (error.kind === 'invalid_config' || error.kind === 'workflow') return 'BLOCKED';
  if (error.kind === 'agent' && error.code === 'contract_violation') return 'CONTRACT_VIOLATION';
  return 'RUN_FAILED';
}

/**
 * The state the node run ends in (Arch §19.1).
 *
 * Two of the eight kinds are not failures of the node at all: a cancellation is the user's doing
 * (`STOPPED`, FR-ERR-007) and an upstream that never produced anything leaves this node with
 * nothing to do (`BLOCKED`, FR-ERR-006 — "BLOCKED shown, not Failed"). `invalid_config` joins
 * `BLOCKED` because Arch §28 puts it there: it is pre-flight's answer, not a run-time fault.
 */
export function nodeStateFor(error: NodeError): NodeState {
  if (error.kind === 'user_cancelled') return 'STOPPED';
  if (error.kind === 'workflow' || error.kind === 'invalid_config') return 'BLOCKED';
  return 'FAILED';
}

/** Whether this kind is something the run should be counted as having failed at (FR-ERR-007). */
export function isFailureKind(kind: NodeError['kind']): boolean {
  return kind !== 'user_cancelled';
}

export interface NodeOutcomeCounts {
  completed: number;
  failed: number;
  /** User cancellations. Counted apart from `failed`, and never added to it (FR-ERR-007). */
  stopped: number;
  blocked: number;
  waiting: number;
  running: number;
  paused: number;
  total: number;
}

/**
 * How a run's node runs tally up (FR-ERR-007, TC-ERR-008).
 *
 * `stopped` is its own column. A run the user stopped has no failures in it, and the run summary
 * must be able to say "3 completed, 2 stopped" rather than "2 failed", which is what the UI shows
 * neutral instead of red.
 *
 * A node with several attempts is counted once, by its latest attempt: a node that failed twice
 * and then succeeded is one completed node, not two failures and a success.
 */
export function countNodeOutcomes(nodeRuns: readonly NodeRun[]): NodeOutcomeCounts {
  const latest = new Map<string, NodeRun>();
  for (const nodeRun of nodeRuns) {
    const key = `${nodeRun.nodeId}:${nodeRun.iteration}`;
    const seen = latest.get(key);
    if (seen === undefined || nodeRun.attempt >= seen.attempt) latest.set(key, nodeRun);
  }

  const counts: NodeOutcomeCounts = {
    completed: 0,
    failed: 0,
    stopped: 0,
    blocked: 0,
    waiting: 0,
    running: 0,
    paused: 0,
    total: latest.size,
  };

  for (const nodeRun of latest.values()) {
    switch (nodeRun.status) {
      case 'COMPLETED':
        counts.completed += 1;
        break;
      case 'FAILED':
        counts.failed += 1;
        break;
      case 'STOPPED':
        counts.stopped += 1;
        break;
      case 'BLOCKED':
        counts.blocked += 1;
        break;
      case 'WAITING':
        counts.waiting += 1;
        break;
      case 'RUNNING':
      case 'READY':
        counts.running += 1;
        break;
      case 'PAUSED':
        counts.paused += 1;
        break;
      case 'IDLE':
        break;
    }
  }

  return counts;
}

/** Did anything actually fail? A stopped run has not (FR-ERR-007). */
export function hasFailures(nodeRuns: readonly NodeRun[]): boolean {
  return countNodeOutcomes(nodeRuns).failed > 0;
}
