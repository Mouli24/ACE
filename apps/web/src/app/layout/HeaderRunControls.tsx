import type { RunAction } from '@ace/contracts';
import { Icons, cn, toast, type LucideIcon } from '@ace/ui';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';

import { usePauseRun, useRestartRun, useResumeRun, useRun, useStopRun } from '../../runs/hooks';
import { useRunStore } from '../../runs/run-store';
import { useSelectedRun } from '../../runs/selected-run';
import { useStartRunFlow } from '../../runs/useStartRunFlow';
import { StopConfirm } from './WorkspaceMenu';

const PILL =
  'flex h-7 shrink-0 cursor-pointer items-center justify-center gap-[6px] rounded-[8px] border border-[var(--line)] bg-transparent text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent';

/**
 * PG-1.2 (D360): Run · Pause · Stop · Restart in the workspace header, in Ideate, Forge and Domain.
 *
 * Run starts this workflow's run (asking an empty Input node for text first, as the "…" menu does).
 * The other three act on the workflow's one selected run (PG-3.2, `useSelectedRun`). Each
 * control is enabled only because the run's `allowedActions` names it (FR-CTL-006): the header
 * decides nothing about the run's state. Pause reads Resume while the run allows resuming. Stop
 * asks first (FR-CTL-003); Restart opens the new run (FR-CTL-004).
 */
export function HeaderRunControls({ workflowId }: { workflowId: string }) {
  const navigate = useNavigate();
  const flow = useStartRunFlow(workflowId);
  // PG-3.2: the one selected run; its actions from the overlay while it holds that run, else from
  // the run's record (a run picked but not yet adopted).
  const { runId: selectedRunId } = useSelectedRun(workflowId);
  const held = useRunStore(
    useShallow((store) =>
      selectedRunId !== undefined &&
      store.workflowId === workflowId &&
      store.runId === selectedRunId
        ? { allowedActions: store.allowedActions }
        : null,
    ),
  );
  const record = useRun(held === null ? selectedRunId : undefined).data;
  const run = {
    runId: selectedRunId,
    allowedActions: held !== null ? held.allowedActions : record?.allowedActions,
  };
  const mutations = {
    pause: usePauseRun(),
    resume: useResumeRun(),
    stop: useStopRun(),
    restart: useRestartRun(),
  };
  const [confirmStop, setConfirmStop] = useState(false);
  const busy = Object.values(mutations).some((mutation) => mutation.isPending);
  const allowed = new Set<RunAction>(run.runId === undefined ? [] : (run.allowedActions ?? []));

  const fire = (action: keyof typeof mutations) => {
    const runId = run.runId;
    if (runId === undefined) return;
    mutations[action].mutate(runId, {
      onSuccess: (result) => {
        if (action === 'restart' && result.id !== runId) navigate(`/runs/${result.id}`);
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
      <button
        type="button"
        aria-label="Run"
        title="Start a run of this workflow"
        data-testid="header-run-start"
        disabled={flow.active || flow.pending}
        onClick={flow.start}
        className={cn(PILL, 'px-[10px]')}
      >
        <Icons.Play aria-hidden size={12} strokeWidth={2.4} />
        Run
      </button>
      {resume
        ? control('resume', 'Resume', Icons.Play, () => fire('resume'))
        : control('pause', 'Pause', Icons.Pause, () => fire('pause'))}
      {control('stop', 'Stop', Icons.Square, () => setConfirmStop(true))}
      {control('restart', 'Restart', Icons.RotateCcw, () => fire('restart'))}
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
