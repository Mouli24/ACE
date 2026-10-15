import type { RunAction } from '@ace/contracts';
import { Icons, cn, toast, type LucideIcon } from '@ace/ui';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { usePauseRun, useRestartRun, useResumeRun, useStopRun } from '../../runs/hooks';
import { useRunStore } from '../../runs/run-store';
import { useOpenRunInPlace } from '../../runs/useOpenRunInPlace';
import { OpenRunEnd, useStartRunFlow } from '../../runs/useStartRunFlow';
import { StopConfirm } from './WorkspaceMenu';

const PILL =
  'flex h-7 shrink-0 cursor-pointer items-center justify-center gap-[6px] rounded-[8px] border border-[var(--line)] bg-transparent text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent';

/**
 * PG-1.2 (D360): Run · Pause · Stop · Restart in the workspace header, in Ideate, Forge and Domain.
 *
 * Run starts this workflow's run (asking an empty Input node for text first, as the "…" menu does).
 * The other three act on the run the overlay holds for this workflow — its active or newest run,
 * as `WorkspaceMenu` uses it; Phase 3 (PG-3.2) makes that one selected run across the modes. Each
 * control is enabled only because the run's `allowedActions` names it (FR-CTL-006): the header
 * decides nothing about the run's state. Pause reads Resume while the run allows resuming. Stop
 * asks first (FR-CTL-003); Restart selects the new run in the same mode (FR-CTL-004, PG-3.5).
 */
export function HeaderRunControls({ workflowId }: { workflowId: string }) {
  const openRun = useOpenRunInPlace();
  const flow = useStartRunFlow(workflowId);
  const run = useRunStore(
    useShallow((store) => {
      const mine = store.workflowId === workflowId;
      return {
        runId: mine ? store.runId : undefined,
        allowedActions: mine ? store.allowedActions : undefined,
      };
    }),
  );
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
          title="Start a run of this workflow"
          data-testid="header-run-start"
          disabled={flow.active || flow.pending}
          onClick={flow.start}
          className={cn(PILL, 'px-[10px]')}
        >
          <Icons.Play aria-hidden size={12} strokeWidth={2.4} />
          Run
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
