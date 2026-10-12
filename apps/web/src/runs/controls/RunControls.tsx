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
 *
 * In the theme (D328) each control is a labelled pill — the modal's Close pill (30px, soft, hairline,
 * 12px / 600), Stop in the destructive red while it is allowed — and a control the engine did not
 * allow is the same pill dimmed.
 */

/** The run the engine answered with. A restart answers with a new run id (FR-CTL-004). */
export interface RunActionResult {
  id: Id;
}

/** What the controls say when the run carries no `allowedActions` (FR-CTL-006). */
const UNKNOWN_ACTIONS = 'the engine did not say which controls this run allows';

/**
 * Sends one control to the engine: `POST /runs/:id/pause` · `/resume` · `/stop` · `/restart`.
 * Returning the run lets the toolbar follow a restart to its new run; returning nothing is fine for
 * the other three.
 */
export type RunActionHandler = (
  action: RunAction,
) => Promise<RunActionResult | void> | RunActionResult | void;

const ACTION_META: Readonly<Record<RunAction, { label: string }>> = {
  pause: { label: 'Pause' },
  resume: { label: 'Resume' },
  stop: { label: 'Stop' },
  restart: { label: 'Restart' },
  end: { label: 'End' },
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
  /** Render the halt note under the buttons. The desktop top bar turns it off (Canvas carries it). */
  showHalt?: boolean;
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
  showHalt = true,
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
      className="flex flex-wrap items-center gap-2 min-[641px]:shrink-0"
      data-testid="run-controls"
      data-status={status}
    >
      <div className="flex flex-wrap items-center gap-[6px]">
        {RUN_ACTIONS.map((action) => {
          const meta = ACTION_META[action];
          const enabled = allowed.has(action) && pending === undefined && !busy;
          return (
            <Button
              key={action}
              size="sm"
              variant={enabled && action === 'stop' ? 'destructive' : 'secondary'}
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
              {meta.label}
            </Button>
          );
        })}
      </div>

      {allowedActions === undefined && (
        <>
          {/* From 641 px to xl the words would wrap out of the 52 px bar: they are visually hidden
              there (still read out) and a "?" carries them as its title. */}
          <span
            data-testid="run-controls-unknown"
            className="max-w-[11rem] text-[11px] leading-[1.45] text-[var(--muted)] min-[641px]:max-xl:sr-only"
            title="FR-CTL-006: the controls follow run.allowedActions, and this run carries none."
          >
            {UNKNOWN_ACTIONS}
          </span>
          <span
            aria-hidden="true"
            title={UNKNOWN_ACTIONS}
            className="hidden h-[22px] w-[22px] cursor-help place-items-center rounded-full border border-[var(--line)] font-machine text-[10px] text-[var(--muted)] min-[641px]:max-xl:inline-grid"
          >
            ?
          </span>
        </>
      )}

      {showHalt && haltReason && (
        <HaltReasonNote
          reason={haltReason}
          {...(budgetHalt === undefined ? {} : { budgetHalt })}
          className="basis-full"
        />
      )}

      {restartedRunId !== undefined && (
        <span className="flex items-center gap-2" data-testid="run-restarted">
          <span className="text-[12px] text-[var(--muted)]">Restarted as a new run.</span>
          {onOpenRun && (
            <button
              type="button"
              className="cursor-pointer border-none bg-transparent p-0 text-[12px] font-semibold text-[#e8623a] outline-none hover:text-[#c94c27] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
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
                <Button variant="secondary" onClick={() => setConfirmStop(false)}>
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
