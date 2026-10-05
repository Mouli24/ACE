import type { Id } from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from '@ace/ui';
import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import { useIsCompact } from '../../responsive/useIsCompact';
import { useApprovals } from '../hooks';
import { ApprovalStack } from './ApprovalStack';

/**
 * How many approvals are waiting, in the top bar (round 3 §5 item 4, FR-GRD-013).
 *
 * The count is `GET /runs/:id/approvals` — the engine's list rather than the socket's fold, so a card
 * raised before this tab connected is counted too, and a decision taken in another tab removes it
 * here as soon as the frame lands (BR-01). Nothing is rendered when nothing is waiting.
 */
export function ApprovalsBadge({ runId }: { runId: Id | undefined }) {
  const approvals = useApprovals(runId);
  const [open, setOpen] = useState(false);
  const compact = useIsCompact();
  const pending = approvals.data ?? [];
  if (pending.length === 0) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        data-testid="approvals-badge"
        data-count={pending.length}
        className={cn(
          'relative h-8 w-8 shrink-0 rounded-full text-fg-muted hover:bg-border hover:text-fg',
          compact && 'min-h-11 min-w-11',
        )}
        aria-label={`${pending.length} ${pending.length === 1 ? 'approval' : 'approvals'} waiting`}
        onClick={() => setOpen(true)}
      >
        <ShieldAlert className="h-4 w-4" aria-hidden />
        <span className="absolute right-0.5 top-[3px] grid h-[15px] min-w-[15px] place-items-center rounded-chip bg-status-WAITING px-1 font-machine text-[9px] font-bold text-[#0a0a0b]">
          {pending.length}
        </span>
      </Button>

      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent
            className={
              compact
                ? 'max-h-[90vh] w-[calc(100vw-1rem)] max-w-md overflow-y-auto p-4'
                : 'max-w-md'
            }
          >
            <div className="flex flex-col gap-3" data-testid="approvals-list">
              <DialogHeader>
                <DialogTitle>
                  {pending.length === 1
                    ? 'One node is waiting'
                    : `${pending.length} nodes are waiting`}
                </DialogTitle>
                <DialogDescription>
                  Each of these stopped at a guardrail that asks you. Nothing continues until you
                  decide.
                </DialogDescription>
              </DialogHeader>
              {/* The same cards as on the Canvas, so a decision reads and behaves identically. */}
              <ApprovalStack requests={pending} />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
