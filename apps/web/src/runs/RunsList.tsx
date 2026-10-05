import type { RunState, RunSummary } from '@ace/contracts';
import { Link } from 'react-router-dom';

import { useRuns } from './hooks';

const RUN_STATE_TONE: Readonly<Record<RunState, string>> = {
  PREFLIGHT: 'text-fg-muted',
  RUNNING: 'text-[var(--color-status-RUNNING)]',
  PAUSED: 'text-[var(--color-status-PAUSED)]',
  COMPLETE: 'text-[var(--color-status-COMPLETED)]',
  BLOCKED: 'text-[var(--color-status-BLOCKED)]',
  HALTED: 'text-danger',
};

const duration = (run: RunSummary): string => {
  if (run.durationMs === undefined) return '—';
  return run.durationMs < 1000 ? `${run.durationMs} ms` : `${(run.durationMs / 1000).toFixed(1)} s`;
};

/**
 * Run history (FR-EXE-012, TC-EXE-011). The engine returns newest first and this renders that
 * order as given — sorting it again here would be a second opinion about what "newest" means.
 */
export function RunsList({ workflowId }: { workflowId: string }) {
  const runs = useRuns(workflowId);

  if (runs.isPending) return <p className="p-4 text-sm text-fg-muted">Loading runs…</p>;
  if (runs.isError) {
    return (
      <p role="alert" className="p-4 text-sm text-danger">
        Could not load runs: {runs.error.message}
      </p>
    );
  }
  if ((runs.data?.length ?? 0) === 0) {
    return <p className="p-4 text-sm text-fg-muted">No runs yet. Press Start to make one.</p>;
  }

  /*
   * One card per run, the same at every width (the V2 sheet is narrow, so a five-column table never
   * fits). The whole card is the link, at least 44 px tall (FR-MOB-001, TC-MOB-001).
   */
  return (
    <ul className="flex flex-col gap-2 p-4" data-testid="runs-table">
      {runs.data?.map((run) => (
        <li
          key={run.id}
          data-testid={`run-row-${run.id}`}
          data-status={run.status}
          className="rounded-[12px] border border-border bg-card"
        >
          <Link
            to={`/runs/${run.id}`}
            className="flex min-h-11 flex-col gap-1 px-3 py-[11px] font-machine text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
          >
            <span className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-fg">{new Date(run.startedAt).toLocaleString()}</span>
              <span className={RUN_STATE_TONE[run.status]}>
                {run.status}
                {run.haltReason ? ` · ${run.haltReason}` : ''}
              </span>
            </span>
            <span className="flex flex-wrap gap-x-3 text-fg-muted">
              <span>{duration(run)}</span>
              <span>
                {run.totals.tokensIn}↓ {run.totals.tokensOut}↑
              </span>
              <span>${run.totals.costUsd.toFixed(4)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
