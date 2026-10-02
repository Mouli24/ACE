import {
  RUN_ACTIONS,
  type BudgetHalt,
  type HaltReason,
  type Id,
  type RunAction,
  type RunState,
} from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ace/ui';
import { CirclePause, CircleStop, Play, RotateCcw, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

import { HaltReasonNote } from './HaltReason';

/**
 * Pause · Resume · Stop · Restart (round 3 §5 item 2, FR-CTL-001..004, FR-CTL-006, TC-CTL-006).
 *
 * The one rule this component exists to keep: **a button is enabled only because
 * `run.allowedActions` names it**. The engine derives that list from the run's state and answers 409
 * `invalid_run_state` to anything else (FR-CTL-006), so the UI reading the status and deciding for
 * itself would be a second, drifting copy of the same table. There is deliberately no fallback:
 * where the engine sent no list, every button is off and the toolbar says so.
 *
 * Stop asks first — it cancels provider calls in flight and cannot be undone. Restart answers with
 * a *new* run (FR-CTL-004), which is the run the operator is then shown.
 */

/** The run the engine answered with. A restart answers with a new run id (FR-CTL-004). */
export interface RunActionResult {
  id: Id;
}

/**
 * Sends one control to the engine: `POST /runs/:id/pause` · `/resume` · `/stop` · `/restart`.
 * Returning the run lets the toolbar follow a restart to its new run; returning nothing is fine for
 * the other three.
 */
export type RunActionHandler = (
  action: RunAction,
) => Promise<RunActionResult | void> | RunActionResult | void;

const ACTION_META: Readonly<Record<RunAction, { label: string; Icon: LucideIcon }>> = {
  pause: { label: 'Pause', Icon: CirclePause },
  resume: { label: 'Resume', Icon: Play },
  stop: { label: 'Stop', Icon: CircleStop },
  restart: { label: 'Restart', Icon: RotateCcw },
};

export interface RunControlsProps {
  /** The run the controls act on; absent means there is nothing to control yet. */
  runId?: Id;
  status?: RunState;
  /**
   * `Run.allowedActions` exactly as the engine wrote it (FR-CTL-006). Undefined means the engine
   * said nothing — not "anything goes": the buttons stay off.
   */
  allowedActions?: readonly RunAction[];
  haltReason?: HaltReason;
  budgetHalt?: BudgetHalt;
  onAction: RunActionHandler;
  /** Open the run a restart created (FR-CTL-004) — the parent owns the router. */
  onOpenRun?: (runId: Id) => void;
  /** Something is already in flight elsewhere (a mutation's `isPending`). */
  busy?: boolean;
}

export function RunControls({
  runId,
  status,
  allowedActions,
  haltReason,
  budgetHalt,
  onAction,
  onOpenRun,
  busy,
}: RunControlsProps) {
  const [pending, setPending] = useState<RunAction>();
  const [confirmStop, setConfirmStop] = useState(false);
  const [restartedRunId, setRestartedRunId] = useState<Id>();

  const allowed = new Set<RunAction>(allowedActions ?? []);

  const fire = async (action: RunAction) => {
    setPending(action);
    try {
      const result = await onAction(action);
      // A restart is a new run, and the new run is the one worth looking at (FR-CTL-004).
      if (action === 'restart' && result && result.id !== runId) {
        setRestartedRunId(result.id);
        onOpenRun?.(result.id);
      }
    } finally {
      setPending(undefined);
    }
  };

  const click = (action: RunAction) => {
    if (action === 'stop') {
      setConfirmStop(true);
      return;
    }
    void fire(action);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="run-controls"
      data-status={status}
    >
      {RUN_ACTIONS.map((action) => {
        const meta = ACTION_META[action];
        const enabled = allowed.has(action) && pending === undefined && !busy;
        return (
          <Button
            key={action}
            size="sm"
            variant="secondary"
            data-testid={`run-action-${action}`}
            data-allowed={allowed.has(action) ? 'true' : 'false'}
            disabled={!enabled}
            onClick={() => click(action)}
            title={
              allowed.has(action)
                ? meta.label
                : `${meta.label} is not available while the run is ${status ?? 'not started'}`
            }
          >
            <meta.Icon className="h-3.5 w-3.5" aria-hidden /> {meta.label}
          </Button>
        );
      })}

      {allowedActions === undefined && (
        <span
          data-testid="run-controls-unknown"
          className="max-w-[11rem] font-machine text-[10px] leading-tight text-fg-muted"
          title="FR-CTL-006: the controls follow run.allowedActions, and this run carries none."
        >
          the engine did not say which controls this run allows
        </span>
      )}

      {haltReason && (
        <HaltReasonNote
          reason={haltReason}
          {...(budgetHalt === undefined ? {} : { budgetHalt })}
          className="basis-full"
        />
      )}

      {restartedRunId !== undefined && (
        <span className="flex items-center gap-2" data-testid="run-restarted">
          <span className="font-human text-xs text-fg-muted">Restarted as a new run.</span>
          {onOpenRun && (
            <button
              type="button"
              className="font-machine text-xs text-accent underline-offset-2 hover:underline"
              onClick={() => onOpenRun(restartedRunId)}
            >
              open the new run
            </button>
          )}
        </span>
      )}

      {confirmStop && (
        <Dialog open onOpenChange={(open) => !open && setConfirmStop(false)}>
          <DialogContent>
            <div className="flex flex-col gap-4" data-testid="stop-confirm">
              <DialogHeader>
                <DialogTitle>Stop this run?</DialogTitle>
                <DialogDescription>
                  Calls in flight are cancelled, the nodes running now become stopped, and the run
                  halts. Nothing already recorded is lost, and you can restart afterwards.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setConfirmStop(false)}>
                  Keep running
                </Button>
                <Button
                  variant="destructive"
                  data-testid="stop-confirm-stop"
                  onClick={() => {
                    setConfirmStop(false);
                    void fire('stop');
                  }}
                >
                  Stop the run
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
