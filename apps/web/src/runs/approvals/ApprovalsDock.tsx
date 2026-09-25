import type { ApprovalRequest, Id } from '@ace/contracts';
import { ApprovalCard } from '@ace/ui';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useApproveNodeRun, useRejectNodeRun } from '../hooks';
import { useRunStore } from '../run-store';

/**
 * Where an `ask_user` guardrail actually reaches a person (FR-GRD-013, TC-GRD-013).
 *
 * The node is WAITING while this is on screen, and it stays WAITING until the engine hears a
 * decision — nothing here changes a state. `node.approval_required` puts a card up,
 * `node.approval_decided` takes it down, and both come from the engine, so a decision taken on
 * another tab clears this one too (BR-01).
 *
 * The dock floats over the Canvas rather than living in a panel, because a run cannot continue past
 * it: an approval is the only thing on screen that a person must answer. Cards stack oldest-first, so
 * the one that has waited longest is read first, and `A`/`R` act on the top card alone.
 */
export function ApprovalsDock({ workflowId }: { workflowId: string }) {
  const requests = useRunStore(
    useShallow((store) => {
      void store.revision;
      return store.workflowId === workflowId ? store.approvals() : [];
    }),
  );
  return <ApprovalStack requests={requests} />;
}

/** The same stack, given its requests — what the inspector and the run detail page reuse. */
export function ApprovalStack({ requests }: { requests: readonly ApprovalRequest[] }) {
  if (requests.length === 0) return null;
  return (
    <div
      data-testid="approvals-dock"
      data-count={requests.length}
      className="pointer-events-none absolute right-4 top-4 z-20 flex max-h-[calc(100%-2rem)] flex-col items-end gap-2 overflow-y-auto"
    >
      {requests.map((request, index) => (
        <ApprovalRow
          key={request.id}
          request={request}
          // Only the top card takes the keyboard, or `A` would answer two questions at once.
          keyboard={index === 0}
        />
      ))}
    </div>
  );
}

function ApprovalRow({ request, keyboard }: { request: ApprovalRequest; keyboard: boolean }) {
  const approve = useApproveNodeRun();
  const reject = useRejectNodeRun();
  const [note, setNote] = useState('');
  const [decided, setDecided] = useState<'approve' | 'reject'>();

  /*
   * The decision is remembered locally only so the card can say what was chosen in the moment
   * between the POST and `node.approval_decided` arriving. The frame is what removes the card.
   */
  const decide = (kind: 'approve' | 'reject') => {
    setDecided(kind);
    const variables = { nodeRunId: request.nodeRunId, ...(note.trim() ? { note: note.trim() } : {}) };
    const mutation = kind === 'approve' ? approve : reject;
    mutation.mutate(variables, { onError: () => setDecided(undefined) });
  };

  return (
    <ApprovalCard
      className="pointer-events-auto"
      request={request}
      pending={approve.isPending || reject.isPending}
      {...(decided === undefined ? {} : { decided })}
      note={note}
      onNoteChange={setNote}
      keyboard={keyboard}
      onApprove={() => decide('approve')}
      onReject={() => decide('reject')}
    />
  );
}

/** How many approvals are waiting on this workflow's run — the top bar's badge (FR-GRD-013). */
export function usePendingApprovalCount(workflowId: Id | undefined): number {
  return useRunStore((store) => {
    void store.revision;
    if (workflowId === undefined || store.workflowId !== workflowId) return 0;
    return store.approvals().length;
  });
}
