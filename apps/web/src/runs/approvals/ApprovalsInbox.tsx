import type { PendingApproval } from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from '@ace/ui';
import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useIsCompact } from '../../responsive/useIsCompact';
import { ApprovalStack } from './ApprovalStack';
import { usePendingApprovals } from './inbox';

/**
 * The approvals inbox in the top bar (ACE parity P1, D270): every approval waiting on a person,
 * across runs and tasks, in one list — where the badge beside it counts only the open run's.
 *
 * Nothing renders while nothing waits. Each entry is the same card as on the Canvas (node, check,
 * reason, preview; Approve and Reject through the existing node-run routes), with a link to its run
 * and, when a task started the run, to the task. A decision removes the card when the list refetches
 * — at once, since deciding invalidates every approvals query.
 */
export function ApprovalsInbox() {
  const pending = usePendingApprovals();
  const [open, setOpen] = useState(false);
  const compact = useIsCompact();
  const items = pending.data ?? [];
  if (items.length === 0 && !open) return null;

  const count = items.length;
  return (
    <>
      {count > 0 && (
        <Button
          variant="ghost"
          size="icon"
          data-testid="approvals-inbox"
          data-count={count}
          className={cn(
            'relative h-8 w-8 shrink-0 rounded-full text-fg-muted hover:bg-border hover:text-fg',
            compact && 'min-h-11 min-w-11',
          )}
          aria-label={`Approvals inbox: ${count} waiting`}
          title="Approvals inbox"
          onClick={() => setOpen(true)}
        >
          <Inbox className="h-4 w-4" aria-hidden />
          <span className="absolute right-0.5 top-[3px] grid h-[15px] min-w-[15px] place-items-center rounded-chip bg-status-WAITING px-1 font-machine text-[9px] font-bold text-[#0a0a0b]">
            {count}
          </span>
        </Button>
      )}

      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent
            className={
              compact
                ? 'max-h-[90vh] w-[calc(100vw-1rem)] max-w-md overflow-y-auto p-4'
                : 'max-h-[85vh] max-w-lg overflow-y-auto'
            }
          >
            <div className="flex flex-col gap-3" data-testid="approvals-inbox-list">
              <DialogHeader>
                <DialogTitle>Approvals inbox</DialogTitle>
                <DialogDescription>
                  {count === 0
                    ? 'Nothing is waiting for you.'
                    : `${count === 1 ? 'One approval is' : `${count} approvals are`} waiting, oldest first. Nothing continues until you decide.`}
                </DialogDescription>
              </DialogHeader>
              {count === 0 ? (
                <p className="text-sm text-fg-muted" data-testid="approvals-inbox-empty">
                  All clear — every request has been answered.
                </p>
              ) : (
                <ol className="flex flex-col gap-4">
                  {items.map((item) => (
                    <InboxEntry
                      key={item.request.id}
                      item={item}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </ol>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function InboxEntry({ item, onNavigate }: { item: PendingApproval; onNavigate: () => void }) {
  const { request, projectId, taskId } = item;
  return (
    <li className="flex flex-col gap-1.5" data-testid={`inbox-entry-${request.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-machine text-[11px]">
        <Link
          to={`/runs/${request.runId}`}
          className="text-fg-soft underline hover:text-fg"
          onClick={onNavigate}
        >
          Open run
        </Link>
        {taskId !== undefined && (
          <Link
            to={`/projects/${projectId}/tasks/${taskId}`}
            className="text-fg-soft underline hover:text-fg"
            onClick={onNavigate}
          >
            Open task
          </Link>
        )}
        <time className="text-fg-muted" dateTime={request.requestedAt}>
          {new Date(request.requestedAt).toLocaleString()}
        </time>
      </div>
      {/*
        The Canvas card, so a decision reads and behaves the same here. No A/R keys: a card on the
        Canvas behind this dialog may already own them, and one key press must not answer twice.
      */}
      <ApprovalStack requests={[request]} keyboard={false} />
    </li>
  );
}
