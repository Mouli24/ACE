import { useShallow } from 'zustand/react/shallow';

import { useRunStore } from '../run-store';
import { HaltReasonNote } from './HaltReason';

/**
 * The halt of this workflow's run, as a pill centred over the Canvas (FR-GRD-008, NFR-USE-03): the
 * theme's pill on `--surface` with its menu shadow (D328). The workspace header no longer carries
 * the halt; the compact header still does.
 */
export function CanvasHaltNote({ workflowId }: { workflowId: string }) {
  const run = useRunStore(
    useShallow((store) => {
      const mine = store.workflowId === workflowId;
      return {
        status: mine ? store.status : undefined,
        haltReason: mine ? store.haltReason : undefined,
        budgetHalt: mine ? store.budgetHalt : undefined,
      };
    }),
  );
  if (run.status !== 'HALTED' || run.haltReason === undefined) return null;
  return (
    // Below the Canvas chrome (breadcrumb ends at 38px, Add node at 46px): over it, a long note hid
    // the "…" menu, which is where Restart and Run details live once a run has halted.
    <div className="absolute left-1/2 top-[58px] z-10 w-max max-w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-full border border-[var(--line)] bg-[var(--surface)] px-[18px] py-[8px] shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]">
      <HaltReasonNote
        reason={run.haltReason}
        {...(run.budgetHalt === undefined ? {} : { budgetHalt: run.budgetHalt })}
      />
    </div>
  );
}
