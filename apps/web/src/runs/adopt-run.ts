import type { Id, Run } from '@ace/contracts';

import { api } from '../app/api';
import { useRunStore } from './run-store';

/** A run that still takes messages and controls: going, paused, or blocked mid-run (D305, D323). */
export const isLiveRun = (run: Pick<Run, 'status'> & { blockedReason?: unknown }): boolean =>
  run.status === 'RUNNING' ||
  run.status === 'PAUSED' ||
  run.status === 'PREFLIGHT' ||
  (run.status === 'BLOCKED' && run.blockedReason !== undefined);

/**
 * Read a run's records and adopt them into the overlay (FR-EXE-014, PG-3.2) — the body of
 * `useAdoptActiveRun`, and [audit W-1] how a failed start puts back the run that was on screen.
 *
 * The overlay is kept as it is when it already follows that run and agrees with its record — live
 * on both sides, or in the same state — so streamed text is not thrown away. A start in flight
 * (armed, no run id yet) is never overwritten. `cancelled` is asked after each read.
 */
export async function adoptRun(
  workflowId: Id,
  runId: Id,
  cancelled: () => boolean = () => false,
): Promise<void> {
  const startInFlight = (): boolean => {
    const store = useRunStore.getState();
    return store.workflowId === workflowId && store.active && store.runId === undefined;
  };
  if (startInFlight()) return;
  try {
    const run = await api().getRun(runId);
    if (cancelled() || startInFlight()) return;
    const store = useRunStore.getState();
    const same = store.workflowId === workflowId && store.runId === run.id;
    if (same && (store.status === run.status || (store.active && isLiveRun(run)))) return;
    const [nodeRuns, approvals] = await Promise.all([
      api().listNodeRuns(run.id),
      api().listApprovals(run.id),
    ]);
    if (!cancelled() && !startInFlight()) {
      useRunStore.getState().adopt(workflowId, run, nodeRuns, approvals);
    }
  } catch {
    // A run that cannot be read (deleted, or the engine away) leaves the overlay as it is.
  }
}
