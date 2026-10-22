import type { Id } from '@ace/contracts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Icons,
  cn,
} from '@ace/ui';
import { useEffect, useState } from 'react';

import { useIsCompact } from '../../responsive/useIsCompact';
import { useApprovals } from '../hooks';
import { ApprovalStack } from './ApprovalStack';

/**
 * How many approvals are waiting, in the phone header (round 3 §5 item 4, FR-GRD-013, FR-MOB-002).
 * Wider screens reach the same dialog from the workspace menu's "Approvals (N)…" (D331).
 *
 * The count is `GET /runs/:id/approvals` — the engine's list rather than the socket's fold, so a card
 * raised before this tab connected is counted too, and a decision taken in another tab removes it
 * here as soon as the frame lands (BR-01). Nothing is rendered when nothing is waiting.
 */
export function ApprovalsBadge({ runId }: { runId: Id | undefined }) {
  const approvals = useApprovals(runId);
  const [open, setOpen] = useState(false);
  const pending = approvals.data ?? [];
  if (runId === undefined) return null;

  return (
    <>
      {pending.length > 0 && (
        <button
          type="button"
          data-testid="approvals-badge"
          data-count={pending.length}
          className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
          aria-label={`${pending.length} ${pending.length === 1 ? 'approval' : 'approvals'} waiting`}
          onClick={() => setOpen(true)}
        >
          <span
            aria-hidden
            className="flex h-6 items-center gap-[6px] rounded-full border border-[var(--line)] bg-[var(--soft)] pl-[9px] pr-[4px] text-[11px] font-semibold text-[var(--ink)]"
          >
            <Icons.Hand aria-hidden size={12} />
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[#ef6b3f] px-1 text-[9px] font-bold text-[#fff]">
              {pending.length}
            </span>
          </span>
        </button>
      )}

      {open && <ApprovalsDialog runId={runId} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The run's waiting approvals as the same cards the Canvas shows (FR-GRD-013), so a decision reads
 * and behaves identically. It closes itself once nothing is left waiting.
 */
export function ApprovalsDialog({ runId, onClose }: { runId: Id; onClose: () => void }) {
  const approvals = useApprovals(runId);
  const compact = useIsCompact();
  const pending = approvals.data ?? [];
  const empty = approvals.data !== undefined && pending.length === 0;
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);
  if (pending.length === 0) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={cn(
          compact ? 'max-h-[90vh] w-[calc(100vw-1rem)] max-w-md overflow-y-auto p-4' : 'max-w-md',
        )}
      >
        <div className="flex flex-col gap-3" data-testid="approvals-list">
          <DialogHeader>
            <DialogTitle>
              {pending.length === 1 ? 'One node is waiting' : `${pending.length} nodes are waiting`}
            </DialogTitle>
            <DialogDescription>
              Each of these stopped at a guardrail that asks you. Nothing continues until you
              decide.
            </DialogDescription>
          </DialogHeader>
          <ApprovalStack requests={pending} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
