import {
  CONTINUABLE_HALT_REASONS,
  canContinueRun,
  type BlockedReason,
  type HaltReason,
  type RunState,
} from '@ace/contracts';
import { Icons, toast } from '@ace/ui';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { usePanelsStore } from '../../app/stores/panels';
import { useSelectionStore } from '../../app/stores/selection';
import { useContinueRun, useNodeRunsOnce, useRestartRun, useResumeRun } from '../hooks';
import { useRunStore } from '../run-store';
import { HaltReasonNote } from './HaltReason';

/** The pill over the Canvas: the theme's pill on `--surface` with its menu shadow (D328). */
const PILL =
  'absolute left-1/2 top-[58px] z-10 w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-full border border-[var(--line)] bg-[var(--surface)] px-[18px] py-[8px] shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]';

/** A pill's action: the header's run-control pill (PG-1.2). */
const ACTION =
  'flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-[8px] border border-[var(--line)] bg-transparent px-[10px] text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-not-allowed disabled:opacity-45';

/** [audit L-2] How long "Run complete" stays over the Canvas once a run finishes in view. */
export const RUN_COMPLETE_MS = 8_000;

/** The states a run finishing in view was in a moment before (Arch §19.2). */
const GOING: ReadonlySet<RunState> = new Set<RunState>(['PREFLIGHT', 'RUNNING', 'PAUSED']);

/** [audit W-5] D305's block in words: what stopped the run, and what each way out does. */
const BLOCKED_TEXT: Readonly<Record<BlockedReason, { what: string; advice: string }>> = {
  LOOP_GUARD: {
    what: 'the loop guard stopped two nodes going back and forth',
    advice: 'Resume lets them carry on; Stop ends the run.',
  },
  BUDGET_EXCEEDED: {
    what: "the run's token budget is used up",
    advice: 'Raising the budget carries it on, as Resume does; Stop ends the run.',
  },
};

/**
 * The halt of this workflow's run, as a pill centred over the Canvas (FR-GRD-008, NFR-USE-03): the
 * theme's pill on `--surface` with its menu shadow (D328). The workspace header no longer carries
 * the halt; the compact header still does.
 *
 * [audit W-5] A run BLOCKED mid-run (D305) shows here too, with its reason and Resume: it is not
 * over, it waits for a person.
 *
 * [audit L-2] A run that finishes COMPLETE while the Canvas watches says so for a few seconds, with
 * the way to its result: the Output node's settings, which show what it produced.
 */
export function CanvasHaltNote({ workflowId }: { workflowId: string }) {
  const run = useRunStore(
    useShallow((store) => {
      const mine = store.workflowId === workflowId;
      return {
        runId: mine ? store.runId : undefined,
        status: mine ? store.status : undefined,
        haltReason: mine ? store.haltReason : undefined,
        budgetHalt: mine ? store.budgetHalt : undefined,
        blockedReason: mine ? store.blockedReason : undefined,
        blockedDetail: mine ? store.blockedDetail : undefined,
        resumable: mine && (store.allowedActions ?? []).includes('resume'),
        restartable: mine && (store.allowedActions ?? []).includes('restart'),
        // the Output node that holds the final result, when the run has one
        outputNodeId: mine ? Object.keys(store.finalOutput ?? {})[0] : undefined,
      };
    }),
  );

  // [audit L-2] the run seen going a moment ago and COMPLETE now: it finished in view
  const seen = useRef<{ runId: string | undefined; status: RunState | undefined }>(run);
  const [completed, setCompleted] = useState<string>();
  useEffect(() => {
    const before = seen.current;
    seen.current = { runId: run.runId, status: run.status };
    const finished =
      run.runId !== undefined &&
      before.runId === run.runId &&
      before.status !== undefined &&
      GOING.has(before.status) &&
      run.status === 'COMPLETE';
    if (finished) setCompleted(run.runId);
  }, [run.runId, run.status]);
  useEffect(() => {
    if (completed === undefined) return;
    const timer = setTimeout(() => setCompleted(undefined), RUN_COMPLETE_MS);
    return () => clearTimeout(timer);
  }, [completed]);

  if (completed !== undefined && completed === run.runId && run.status === 'COMPLETE') {
    return (
      <RunCompleteNote
        {...(run.outputNodeId === undefined ? {} : { outputNodeId: run.outputNodeId })}
        onDismiss={() => setCompleted(undefined)}
      />
    );
  }
  if (run.status === 'BLOCKED' && run.blockedReason !== undefined && run.runId !== undefined) {
    return (
      <BlockedNote
        runId={run.runId}
        reason={run.blockedReason}
        resumable={run.resumable}
        {...(run.blockedDetail === undefined ? {} : { detail: run.blockedDetail })}
      />
    );
  }
  if (run.status !== 'HALTED' || run.haltReason === undefined) return null;
  return (
    // Below the Canvas chrome (breadcrumb ends at 38px, Add node at 46px): over it, a long note hid
    // the "…" menu, which is where Restart and Run details live once a run has halted.
    // [audit W-15] a status: the halt is said once when it lands, without interrupting
    <div role="status" className={`${PILL} flex items-center gap-3`}>
      <HaltReasonNote
        reason={run.haltReason}
        {...(run.budgetHalt === undefined ? {} : { budgetHalt: run.budgetHalt })}
      />
      {run.runId !== undefined && (
        <HaltActions runId={run.runId} reason={run.haltReason} restartable={run.restartable} />
      )}
    </div>
  );
}

/**
 * [audit W-16] The advice under a halt, as buttons: a failure opens the Errors tab (where the failed
 * node and its Retry are); a run cut off with work left offers Continue (D388, `canContinueRun` —
 * the rule the engine enforces); and Restart wherever the run allows it (FR-CTL-004). The header
 * carries the same controls; this puts them where the advice is read.
 */
function HaltActions({
  runId,
  reason,
  restartable,
}: {
  runId: string;
  reason: HaltReason;
  restartable: boolean;
}) {
  const restart = useRestartRun();
  const carryOn = useContinueRun();
  const mayContinue = (CONTINUABLE_HALT_REASONS as readonly string[]).includes(reason);
  const nodeRuns = useNodeRunsOnce(mayContinue ? runId : undefined);
  const canContinue =
    mayContinue &&
    nodeRuns.data !== undefined &&
    canContinueRun({ status: 'HALTED', haltReason: reason }, nodeRuns.data);
  const busy = restart.isPending || carryOn.isPending;
  const onError = (error: Error) => toast.error(error.message);
  return (
    <div className="flex shrink-0 items-center gap-[6px]">
      {reason === 'failure' && (
        <button
          type="button"
          data-testid="halt-show-errors"
          onClick={() => usePanelsStore.getState().setBottomTab('errors')}
          className={ACTION}
        >
          Show errors
        </button>
      )}
      {canContinue && (
        <button
          type="button"
          data-testid="halt-continue"
          disabled={busy || nodeRuns.isFetching}
          onClick={() => carryOn.mutate(runId, { onError })}
          className={ACTION}
        >
          Continue
        </button>
      )}
      {restartable && (
        <button
          type="button"
          data-testid="halt-restart"
          disabled={busy}
          onClick={() => restart.mutate(runId, { onError })}
          className={ACTION}
        >
          Restart
        </button>
      )}
    </div>
  );
}

/** [audit W-5] A run blocked mid-run (D305): the reason, the engine's words, and Resume. */
function BlockedNote({
  runId,
  reason,
  detail,
  resumable,
}: {
  runId: string;
  reason: BlockedReason;
  detail?: string;
  resumable: boolean;
}) {
  const resume = useResumeRun();
  const text = BLOCKED_TEXT[reason];
  return (
    <div role="status" className={`${PILL} flex items-center gap-3`}>
      <div data-testid="blocked-reason" data-reason={reason} className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-[6px] h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--color-status-BLOCKED)]"
        />
        <div className="flex flex-col gap-[2px]">
          <p className="m-0 text-[13px] text-[var(--ink)]">Run blocked — {text.what}</p>
          <p className="m-0 text-[11px] leading-[1.45] text-[var(--muted)]">
            {detail === undefined ? text.advice : `${detail} ${text.advice}`}
          </p>
        </div>
      </div>
      <button
        type="button"
        data-testid="blocked-resume"
        disabled={!resumable || resume.isPending}
        onClick={() => resume.mutate(runId, { onError: (error) => toast.error(error.message) })}
        className={ACTION}
      >
        Resume
      </button>
    </div>
  );
}

/** [audit L-2] "Run complete", and the Output node's result one press away. */
function RunCompleteNote({
  outputNodeId,
  onDismiss,
}: {
  outputNodeId?: string;
  onDismiss: () => void;
}) {
  const openResult = (nodeId: string) => {
    useSelectionStore.getState().setSelection([nodeId], []);
    usePanelsStore.getState().openSettings({ kind: 'node', id: nodeId });
    onDismiss();
  };
  return (
    <div role="status" data-testid="run-complete" className={`${PILL} flex items-center gap-3`}>
      <span className="flex items-center gap-2 text-[13px] text-[var(--ink)]">
        <span
          aria-hidden
          className="h-[7px] w-[7px] shrink-0 rounded-full bg-[var(--color-status-COMPLETED)]"
        />
        Run complete
      </span>
      {outputNodeId !== undefined && (
        <button
          type="button"
          data-testid="run-complete-result"
          onClick={() => openResult(outputNodeId)}
          className={ACTION}
        >
          See the result
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[7px] border-none bg-transparent text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
      >
        <Icons.X aria-hidden size={12} />
      </button>
    </div>
  );
}
