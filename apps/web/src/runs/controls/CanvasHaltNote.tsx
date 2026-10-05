import { useShallow } from 'zustand/react/shallow';

import { useRunStore } from '../run-store';
import { HaltReasonNote } from './HaltReason';

/**
 * The halt of this workflow's run, as a pill centred over the Canvas (FR-GRD-008, NFR-USE-03). The
 * desktop top bar no longer carries it (`RunBar haltInline={false}`); the compact header still does.
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
    <div className="absolute left-1/2 top-3.5 z-10 -translate-x-1/2 rounded-chip border border-border bg-panel px-3.5 py-2 text-[13.5px] text-fg-soft shadow-[var(--ace-ground)]">
      <HaltReasonNote
        reason={run.haltReason}
        {...(run.budgetHalt === undefined ? {} : { budgetHalt: run.budgetHalt })}
      />
    </div>
  );
}
