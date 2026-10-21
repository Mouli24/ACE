import type { BlockedReason } from '@ace/contracts';
import { toast } from '@ace/ui';
import { useShallow } from 'zustand/react/shallow';

import { useResumeRun } from '../hooks';
import { useRunStore } from '../run-store';
import { HaltReasonNote } from './HaltReason';

/** The pill over the Canvas: the theme's pill on `--surface` with its menu shadow (D328). */
const PILL =
  'absolute left-1/2 top-[58px] z-10 w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-full border border-[var(--line)] bg-[var(--surface)] px-[18px] py-[8px] shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]';

/** A pill's action: the header's run-control pill (PG-1.2). */
const ACTION =
  'flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-[8px] border border-[var(--line)] bg-transparent px-[10px] text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-not-allowed disabled:opacity-45';

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
      };
    }),
  );
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
    <div className={PILL}>
      <HaltReasonNote
        reason={run.haltReason}
        {...(run.budgetHalt === undefined ? {} : { budgetHalt: run.budgetHalt })}
      />
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
    <div className={`${PILL} flex items-center gap-3`}>
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
