import type { Id, RunSummary } from '@ace/contracts';
import { useCallback, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { adoptRun, isLiveRun } from './adopt-run';
import { useRunStore } from './run-store';
import { useRuns } from './hooks';

export { isLiveRun };

/**
 * PG-3.2: one selected run for the workflow, in every mode. It lives in the URL (`?run=`), so a
 * mode switch, a reload or a shared link keeps it, and it is read here — by Ideate, Forge, Domain,
 * the footer, the Inspector and the header's run controls — and nowhere else.
 *
 * Without `?run=` it is the run this client has going, else the workflow's live run, else its
 * newest. `?run=new` is Domain's "write a goal to start a run": no run selected.
 */
export interface SelectedRun {
  /** The run on show, or none (no runs yet, or `?run=new`). */
  runId: Id | undefined;
  /** Whether `?run=` names it, rather than the default choosing it. */
  explicit: boolean;
  /** `?run=new`. */
  isNew: boolean;
  /** The workflow's runs, newest first. */
  runs: readonly RunSummary[] | undefined;
  /** The run list is still loading, so no default can be chosen yet. */
  loading: boolean;
  /** Select a run (`undefined` goes back to the default), keeping the rest of the query. */
  select(runId: Id | 'new' | undefined): void;
}

export function useSelectedRun(workflowIdArg?: Id): SelectedRun {
  const params = useParams();
  const workflowId = workflowIdArg ?? params.workflowId;
  const [search, setSearch] = useSearchParams();
  const requested = search.get('run') ?? undefined;
  const runs = useRuns(workflowId);
  // The run this client started (or follows live) for this workflow, before the list knows it.
  const following = useRunStore((store) =>
    store.workflowId === workflowId && store.active ? store.runId : undefined,
  );

  const list = runs.data;
  const fallback = following ?? (list?.find((each) => isLiveRun(each)) ?? list?.[0])?.id;
  const isNew = requested === 'new';
  const runId = isNew ? undefined : (requested ?? fallback);

  const select = useCallback(
    (next: Id | 'new' | undefined) => {
      setSearch(
        (current) => {
          const query = new URLSearchParams(current);
          if (next === undefined) query.delete('run');
          else query.set('run', next);
          return query;
        },
        { replace: true },
      );
    },
    [setSearch],
  );

  return {
    runId,
    explicit: requested !== undefined && !isNew,
    isNew,
    runs: list,
    loading: runs.isLoading,
    select,
  };
}

/**
 * Adopt the selected run into the overlay (FR-EXE-014, PG-3.2), finished or live: on opening a
 * workflow, when the selection changes, and on coming back to a mode. A reload loses the in-memory
 * overlay, and the socket cannot help — it seeds `lastSeq` from `hello`, so `resume` replays nothing
 * from before the load — so the records are the way back, after which live frames carry on.
 *
 * The overlay is kept as it is when it already follows that run and agrees with its record — live
 * on both sides, or in the same state — so streamed text is not thrown away by a mode switch. An
 * overlay still saying RUNNING for a run the engine has finished is rebuilt (the Canvas stuck on
 * RUNNING after Domain, M1). A start in flight (armed, no run id yet) is never overwritten.
 *
 * A ref-free effect with nothing to render: nothing to adopt means nothing happens, so the Canvas
 * is not re-rendered under a drag that has just begun (D-029).
 */
export function useAdoptActiveRun(workflowId: Id | undefined, mode?: string): void {
  const { runId } = useSelectedRun(workflowId);

  useEffect(() => {
    if (workflowId === undefined || runId === undefined) return;
    let cancelled = false;
    // [audit W-1] the body is `adoptRun`, which a failed start also uses to put this run back
    void adoptRun(workflowId, runId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [workflowId, runId, mode]);
}

/**
 * When this client starts a run (or a restart makes a new one), the selection moves to it — even
 * from a run picked by `?run=` (PG-3.2). Mounted once, by the workflow layout.
 */
export function useFollowStartedRun(workflowId: Id | undefined): void {
  const { runId, explicit, select } = useSelectedRun(workflowId);
  const started = useRunStore((store) =>
    store.workflowId === workflowId && store.active ? store.runId : undefined,
  );
  const previous = useRef(started);
  useEffect(() => {
    const before = previous.current;
    previous.current = started;
    // Only a change to a run newly followed: adopting the selected run never moves the selection.
    if (started === undefined || started === before || started === runId || !explicit) return;
    select(started);
  }, [started, runId, explicit, select]);
}
