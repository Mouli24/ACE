import type { RunSummary } from '@ace/contracts';
import { Link } from 'react-router-dom';

import { useRuns } from './hooks';
import { RunStateChip } from './RunStateChip';

const duration = (run: RunSummary): string => {
  if (run.durationMs === undefined) return '—';
  return run.durationMs < 1000 ? `${run.durationMs} ms` : `${(run.durationMs / 1000).toFixed(1)} s`;
};

/**
 * Run history (FR-EXE-012, TC-EXE-011). The engine returns newest first and this renders that
 * order as given — sorting it again here would be a second opinion about what "newest" means.
 *
 * In the theme (D328) it is a table of 12.5px rows with a hairline between them; the container
 * (the Runs page's card, the workflow panel) supplies the frame and the side padding.
 */
export function RunsList({ workflowId }: { workflowId: string }) {
  const runs = useRuns(workflowId);

  if (runs.isPending) {
    return <p className="m-0 py-[10px] text-[13px] text-[var(--muted)]">Loading runs…</p>;
  }
  if (runs.isError) {
    return (
      <p role="alert" className="m-0 py-[10px] text-[13px] text-[#c94c27]">
        Could not load runs: {runs.error.message}
      </p>
    );
  }
  if ((runs.data?.length ?? 0) === 0) {
    return (
      <p className="m-0 py-[10px] text-[13px] text-[var(--muted)]">
        No runs yet. Press Start to make one.
      </p>
    );
  }

  /*
   * One row per run, the same at every width (the workflow panel is narrow, so a five-column table
   * never fits). The whole row is the link, at least 44 px tall (FR-MOB-001, TC-MOB-001).
   */
  return (
    <ul className="m-0 flex list-none flex-col p-0" data-testid="runs-table">
      {runs.data?.map((run) => (
        <li
          key={run.id}
          data-testid={`run-row-${run.id}`}
          data-status={run.status}
          className="border-t border-[var(--line)] first:border-t-0"
        >
          <Link
            to={`/runs/${run.id}`}
            className="flex min-h-11 flex-col justify-center gap-[3px] rounded-[7px] py-[8px] text-[12.5px] text-[var(--ink)] outline-none hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
          >
            <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span>{new Date(run.startedAt).toLocaleString()}</span>
              <RunStateChip
                status={run.status}
                {...(run.haltReason === undefined ? {} : { haltReason: run.haltReason })}
              />
            </span>
            <span className="flex flex-wrap gap-x-3 font-machine text-[11px] text-[var(--muted)]">
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
