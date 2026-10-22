import { CONTINUABLE_HALT_REASONS, canContinueRun, type RunAction } from '@ace/contracts';
import { Icons, cn, toast, type LucideIcon } from '@ace/ui';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import {
  useContinueRun,
  useNodeRunsOnce,
  usePauseRun,
  useRestartRun,
  useResumeRun,
  useRun,
  useStopRun,
} from '../../runs/hooks';
import { useRunStore } from '../../runs/run-store';
import { useOpenRunInPlace } from '../../runs/useOpenRunInPlace';
import { useSelectedRun } from '../../runs/selected-run';
import { estimateTitle } from '../../runs/estimate';
import { OpenRunEnd, RunEstimateTag, useStartRunFlow } from '../../runs/useStartRunFlow';
import { StopConfirm } from './WorkspaceMenu';

const PILL =
  'flex h-7 shrink-0 cursor-pointer items-center justify-center gap-[6px] rounded-[8px] border border-[var(--line)] bg-transparent text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent';

/**
 * PG-1.2 (D360): Run · Pause · Stop · Restart in the workspace header, in Ideate, Forge and Domain.
 *
 * Run starts this workflow's run (asking an empty Input node for text first, as the "…" menu does).
 * The other three act on the workflow's one selected run (PG-3.2, `useSelectedRun`). Each
 * control is enabled only because the run's `allowedActions` names it (FR-CTL-006): the header
 * decides nothing about the run's state. Pause reads Resume while the run allows resuming. Stop
 * asks first (FR-CTL-003); Restart selects the new run in the same mode (FR-CTL-004, PG-3.5).
 *
 * D388: Continue joins them only while the selected run was cut off with work left — HALTED by a
 * crash, a shutdown or a Stop, with an interrupted node run. `continue` is deliberately not a
 * `RUN_ACTIONS` value (an older engine on the shared database would refuse a run carrying an action
 * it does not know), so the header asks the contract's `canContinueRun` — the same rule the engine
 * enforces — over the run's recorded node runs, which it reads only for a run halted that way.
 */
export function HeaderRunControls({ workflowId }: { workflowId: string }) {
  const openRun = useOpenRunInPlace();
  const flow = useStartRunFlow(workflowId);
  // PG-3.2: the one selected run; its actions from the overlay while it holds that run, else from
  // the run's record (a run picked but not yet adopted).
  const { runId: selectedRunId } = useSelectedRun(workflowId);
  const held = useRunStore(
    useShallow((store) =>
      selectedRunId !== undefined &&
      store.workflowId === workflowId &&
      store.runId === selectedRunId
        ? {
            allowedActions: store.allowedActions,
            status: store.status,
            haltReason: store.haltReason,
          }
        : null,
    ),
  );
  const record = useRun(held === null ? selectedRunId : undefined).data;
  const run = {
    runId: selectedRunId,
    allowedActions: held !== null ? held.allowedActions : record?.allowedActions,
    status: held !== null ? held.status : record?.status,
    haltReason: held !== null ? held.haltReason : record?.haltReason,
  };
  // D388: the node runs only matter once the run halted in a way Continue can carry on from.
  const mayContinue =
    run.runId !== undefined &&
    run.status === 'HALTED' &&
    (CONTINUABLE_HALT_REASONS as readonly string[]).includes(run.haltReason ?? '');
  const nodeRunsQuery = useNodeRunsOnce(mayContinue ? run.runId : undefined);
  const nodeRuns = nodeRunsQuery.data;
  const canContinue =
    mayContinue &&
    run.status !== undefined &&
    nodeRuns !== undefined &&
    canContinueRun({ status: run.status, haltReason: run.haltReason }, nodeRuns);
  const mutations = {
    pause: usePauseRun(),
    resume: useResumeRun(),
    stop: useStopRun(),
    restart: useRestartRun(),
    continue: useContinueRun(),
  };
  const [confirmStop, setConfirmStop] = useState(false);
  const busy = Object.values(mutations).some((mutation) => mutation.isPending);
  const allowed = new Set<RunAction>(run.runId === undefined ? [] : (run.allowedActions ?? []));

  const fire = (action: keyof typeof mutations) => {
    const runId = run.runId;
    if (runId === undefined) return;
    mutations[action].mutate(runId, {
      onSuccess: (result) => {
        // PG-3.5 (D360): the restarted run is selected where the person is, in the same mode.
        if (action === 'restart' && result.id !== runId) openRun(result.id);
      },
      onError: (error) => toast.error(error.message),
    });
  };

  const resume = allowed.has('resume');
  const control = (
    action: 'pause' | 'resume' | 'stop' | 'restart',
    label: string,
    Icon: LucideIcon,
    onClick: () => void,
  ) => {
    const enabled = allowed.has(action) && !busy;
    return (
      <button
        type="button"
        aria-label={label}
        title={enabled ? label : `${label} — not available for this run now`}
        data-testid={`header-run-${action}`}
        disabled={!enabled}
        onClick={onClick}
        className={cn(PILL, 'w-7 p-0', action === 'stop' && enabled && 'text-[var(--danger-ink)]')}
      >
        <Icon aria-hidden size={13} strokeWidth={2.2} />
      </button>
    );
  };

  return (
    <div role="group" aria-label="Run controls" className="flex items-center gap-[4px]">
      {flow.open === undefined ? (
        <button
          type="button"
          aria-label="Run"
          title={
            flow.estimate === undefined
              ? 'Start a run of this workflow'
              : `Start a run of this workflow — ${estimateTitle(flow.estimate)}`
          }
          data-testid="header-run-start"
          disabled={flow.active || flow.pending}
          onClick={flow.start}
          className={cn(PILL, 'px-[10px]')}
        >
          <Icons.Play aria-hidden size={12} strokeWidth={2.4} />
          Run
          <RunEstimateTag estimate={flow.estimate} />
        </button>
      ) : (
        // PG-3.5 (D323): a run started from Domain is open until ended; say so, offer the End.
        <OpenRunEnd open={flow.open} />
      )}
      {resume
        ? control('resume', 'Resume', Icons.Play, () => fire('resume'))
        : control('pause', 'Pause', Icons.Pause, () => fire('pause'))}
      {control('stop', 'Stop', Icons.Square, () => setConfirmStop(true))}
      {control('restart', 'Restart', Icons.RotateCcw, () => fire('restart'))}
      {canContinue && (
        <button
          type="button"
          aria-label="Continue"
          title="Run the nodes that were cut off; keep what finished"
          data-testid="header-run-continue"
          // held while the node runs are read again (after a click, until the retries show)
          disabled={busy || nodeRunsQuery.isFetching}
          onClick={() => fire('continue')}
          className={cn(PILL, 'px-[10px]')}
        >
          <Icons.StepForward aria-hidden size={12} strokeWidth={2.4} />
          Continue
        </button>
      )}
      {flow.dialog}
      {confirmStop && (
        <StopConfirm
          onCancel={() => setConfirmStop(false)}
          onStop={() => {
            setConfirmStop(false);
            fire('stop');
          }}
        />
      )}
    </div>
  );
}
