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

  return (
    <table className="w-full border-collapse text-sm" data-testid="runs-table">
      <thead>
        <tr className="border-b border-border text-left text-xs uppercase text-fg-muted">
          <th className="px-3 py-2 font-normal">Started</th>
          <th className="px-3 py-2 font-normal">Status</th>
          <th className="px-3 py-2 font-normal">Duration</th>
          <th className="px-3 py-2 font-normal">Tokens</th>
          <th className="px-3 py-2 font-normal">Cost</th>
        </tr>
      </thead>
      <tbody>
        {runs.data?.map((run) => (
          <tr
            key={run.id}
            className="border-b border-border/60"
            data-testid={`run-row-${run.id}`}
            data-status={run.status}
          >
            <td className="px-3 py-2">
              <Link to={`/runs/${run.id}`} className="font-machine text-xs hover:underline">
                {new Date(run.startedAt).toLocaleString()}
              </Link>
            </td>
            <td className={`px-3 py-2 font-machine text-xs ${RUN_STATE_TONE[run.status]}`}>
              {run.status}
              {run.haltReason ? ` · ${run.haltReason}` : ''}
            </td>
            <td className="px-3 py-2 font-machine text-xs">{duration(run)}</td>
            <td className="px-3 py-2 font-machine text-xs">
              {run.totals.tokensIn}↓ {run.totals.tokensOut}↑
            </td>
            <td className="px-3 py-2 font-machine text-xs">${run.totals.costUsd.toFixed(4)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
