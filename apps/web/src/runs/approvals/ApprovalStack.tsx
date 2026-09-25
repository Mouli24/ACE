import type { ApprovalRequest } from '@ace/contracts';
import { ApprovalCard } from '@ace/ui';
import { useState } from 'react';

import { useApproveNodeRun, useRejectNodeRun } from '../hooks';

/**
 * Where an `ask_user` guardrail actually reaches a person (FR-GRD-013, TC-GRD-008/009).
 *
 * The node is WAITING while a card is on screen, and it stays WAITING until the engine hears a
 * decision — nothing here changes a state. `node.approval_required` puts a card up,
 * `node.approval_decided` takes it down, and both come from the engine, so a decision taken in
 * another tab clears this one too (BR-01).
 *
 * Every pending approval of this workflow's run, oldest first, so the one that has waited longest is
 * read first. No positioning of its own: it is anchored to its node on the Canvas, and listed behind
 * the top bar's badge and in the run view. `A` and `R` belong to one card at a time, which is what
 * `keyboard` is for.
 */
export function ApprovalStack({
  requests,
  className,
  keyboard = true,
}: {
  requests: readonly ApprovalRequest[];
  className?: string;
  /** False where another card on screen owns `A` and `R` — only one may. */
  keyboard?: boolean;
}) {
  return (
    <div className={`flex w-full flex-col gap-2 ${className ?? ''}`}>
      {requests.map((request, index) => (
        <ApprovalRow key={request.id} request={request} keyboard={keyboard && index === 0} />
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
