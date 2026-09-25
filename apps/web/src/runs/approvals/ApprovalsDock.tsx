import type { ApprovalRequest, Id } from '@ace/contracts';
import { ApprovalCard } from '@ace/ui';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useApproveNodeRun, useRejectNodeRun } from '../hooks';
import { useRunStore } from '../run-store';

/**
 * Where an `ask_user` guardrail actually reaches a person (FR-GRD-013, TC-GRD-013).
 *
 * The node is WAITING while a card is on screen, and it stays WAITING until the engine hears a
 * decision — nothing here changes a state. `node.approval_required` puts a card up,
 * `node.approval_decided` takes it down, and both come from the engine, so a decision taken in
 * another tab clears this one too (BR-01).
 *
 * The dock floats over the Canvas rather than living in a panel, because a run cannot continue past
 * it: an approval is the only thing on screen a person must answer.
 */
export function ApprovalsDock({ workflowId }: { workflowId: string }) {
  const requests = useRunStore(
    useShallow((store) => {
      void store.revision;
      return store.workflowId === workflowId ? store.approvals() : [];
    }),
  );
  if (requests.length === 0) return null;
  return (
    <div
      data-testid="approvals-dock"
      data-count={requests.length}
      className="pointer-events-none absolute right-4 top-4 z-20 flex max-h-[calc(100%-2rem)] w-[min(24rem,calc(100%-2rem))] flex-col items-end overflow-y-auto"
    >
      <ApprovalStack requests={requests} className="pointer-events-auto" />
    </div>
  );
}

/**
 * The cards themselves, oldest first so the one that has waited longest is read first. `A` and `R`
 * act on the top card alone — one key press must never answer two questions.
 *
 * No positioning of its own, so the same stack serves the Canvas dock and the top bar's badge.
 */
export function ApprovalStack({
  requests,
  className,
}: {
  requests: readonly ApprovalRequest[];
  className?: string;
}) {
  return (
    <div className={`flex w-full flex-col gap-2 ${className ?? ''}`}>
      {requests.map((request, index) => (
        <ApprovalRow key={request.id} request={request} keyboard={index === 0} />
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
    const variables = {
      nodeRunId: request.nodeRunId,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const mutation = kind === 'approve' ? approve : reject;
    mutation.mutate(variables, { onError: () => setDecided(undefined) });
  };

  return (
    <ApprovalCard
      className="w-full max-w-none"
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

/** How many approvals are waiting on this workflow's run — what a count in the shell reads. */
export function usePendingApprovalCount(workflowId: Id | undefined): number {
  return useRunStore((store) => {
    void store.revision;
    if (workflowId === undefined || store.workflowId !== workflowId) return 0;
    return store.approvals().length;
  });
}
