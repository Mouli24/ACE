import type { HaltReason, Id, RunAction, RunState } from '@ace/contracts';
import { Button, Icons, cn } from '@ace/ui';
import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';

import { CostValue } from './CostValue';
import { RunControls } from './controls/RunControls';
import {
  usePauseRun,
  useRestartRun,
  useResumeRun,
  useSocketStatus,
  useStopRun,
  useEndRun,
} from './hooks';
import { useRunStore } from './run-store';
import { useStartRunFlow } from './useStartRunFlow';

/** Run state → how the badge reads. The enum name stays the contract (BR-03: COMPLETE ≠ HALTED). */
const RUN_STATE_LABEL: Readonly<Record<RunState, string>> = {
  PREFLIGHT: 'pre-flight',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETE: 'complete',
  BLOCKED: 'blocked',
  HALTED: 'halted',
};

/** The run state as a theme status colour. A stopped halt reads STOPPED, any other FAILED. */
function runStateColor(status: RunState, haltReason: HaltReason | undefined): string {
  const name = {
    PREFLIGHT: 'READY',
    RUNNING: 'RUNNING',
    PAUSED: 'PAUSED',
    COMPLETE: 'COMPLETED',
    BLOCKED: 'BLOCKED',
    HALTED: haltReason === 'stopped' ? 'STOPPED' : 'FAILED',
  }[status];
  return `var(--color-status-${name})`;
}

const money = (value: number) => `$${value.toFixed(4)}`;

/**
 * Start, run status and totals in the phone header (FR-EXE-001, FR-OBS-002, FR-MOB-001). On wider
 * screens the workspace footer carries the connection and totals, and the "…" menu starts and
 * controls the run (D330, D331). One active run per workflow: while a run is in flight Start is
 * not offered rather than queuing a second one.
 *
 * Pause · Resume · Stop · Restart sit beside it (FR-CTL-001..004). Which of them is live is not
 * decided here: `RunControls` enables a button only because `Run.allowedActions` names it, and that
 * list comes from the engine through the overlay (FR-CTL-006, BR-01).
 */
export function RunBar({ workflowId }: { workflowId: string }) {
  const navigate = useNavigate();
  const flow = useStartRunFlow(workflowId);
  const socketStatus = useSocketStatus();

  // A fresh object per call would re-render forever; the shallow compare is what makes it stable.
  const run = useRunStore(
    useShallow((store) => {
      const mine = store.workflowId === workflowId;
      return {
        runId: mine ? store.runId : undefined,
        status: mine ? store.status : undefined,
        haltReason: mine ? store.haltReason : undefined,
        budgetHalt: mine ? store.budgetHalt : undefined,
        allowedActions: mine ? store.allowedActions : undefined,
        totals: mine ? store.totals : undefined,
      };
    }),
  );

  /*
   * One mutation per control rather than one that switches: each has its own `isPending`, and a
   * restart writes a *new* run into the overlay, which the others must not do (FR-CTL-004).
   */
  const pause = usePauseRun();
  const resume = useResumeRun();
  const stop = useStopRun();
  const restart = useRestartRun();
  const end = useEndRun();
  const busy =
    pause.isPending || resume.isPending || stop.isPending || restart.isPending || end.isPending;

  const onAction = async (action: RunAction) => {
    if (run.runId === undefined) return;
    const mutation = { pause, resume, stop, restart, end }[action];
    return mutation.mutateAsync(run.runId);
  };

  return (
    <div className="flex items-center gap-2" data-testid="run-bar">
      {socketStatus === 'reconnecting' && (
        <span
          role="status"
          data-testid="socket-reconnecting"
          className="font-machine text-[10px] text-[var(--muted)]"
        >
          Reconnecting…
        </span>
      )}

      {run.status && (
        <span
          data-testid="run-status"
          data-status={run.status}
          className="inline-flex h-[26px] shrink-0 items-center gap-[7px] whitespace-nowrap rounded-full border px-[11px] font-machine text-[10px] uppercase tracking-[0.06em]"
          style={{
            color: runStateColor(run.status, run.haltReason),
            borderColor: `color-mix(in oklab, ${runStateColor(run.status, run.haltReason)} 40%, transparent)`,
          }}
        >
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full bg-current',
              run.status === 'RUNNING' && 'ace-pulse',
            )}
          />
          <span>
            run {RUN_STATE_LABEL[run.status]}
            {run.haltReason && ` · ${run.haltReason}`}
          </span>
        </span>
      )}

      {run.totals && (
        <span
          data-testid="run-totals"
          className="shrink-0 whitespace-nowrap font-machine text-[10px] text-[var(--muted)]"
        >
          {run.totals.tokensIn}↓ {run.totals.tokensOut}↑{' '}
          <CostValue usage={run.totals} format={money} />
        </span>
      )}

      {!flow.active && (
        <Button size="sm" aria-label="Start run" onClick={flow.start} disabled={flow.pending}>
          <Icons.Play aria-hidden size={12} /> Run
        </Button>
      )}

      <RunControls
        {...(run.runId === undefined ? {} : { runId: run.runId })}
        {...(run.status === undefined ? {} : { status: run.status })}
        {...(run.allowedActions === undefined ? {} : { allowedActions: run.allowedActions })}
        {...(run.haltReason === undefined ? {} : { haltReason: run.haltReason })}
        {...(run.budgetHalt === undefined ? {} : { budgetHalt: run.budgetHalt })}
        onAction={onAction}
        onOpenRun={(runId: Id) => navigate(`/runs/${runId}`)}
        busy={busy}
      />

      {flow.dialog}
    </div>
  );
}
