import { TOOL_NAME_REGEX, type ApprovalRequest } from '@ace/contracts';
import { ApprovalCard, Button, Icons, toast } from '@ace/ui';
import { useState } from 'react';

import { TOUCH_TARGETS } from '../../responsive/touch';
import { useIsCompact } from '../../responsive/useIsCompact';
import { agentMap } from '../../theme/agents';
import { useWorkflowGraph } from '../../workflows/hooks';
import { useApproveNodeRun, useRejectNodeRun } from '../hooks';
import { useRunStore } from '../run-store';

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
 *
 * D391 (W1-7): with two or more waiting, of which two or more are not destructive, "Approve all (n)"
 * approves those n one by one, oldest first, through the same per-approval call as each card's
 * Approve. A destructive one is never in it — Arch §13.1, destructive always asks — so it stays
 * pending with its card, and the button's tooltip names it. There is no Deny all: a rejection
 * fails the node, and is decided card by card.
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
  // At phone width Approve and Reject are finger-sized (FR-MOB-002, TC-MOB-002).
  const compact = useIsCompact();
  const bulk = useApproveAll(requests);
  return (
    <div
      className={`flex w-full min-w-0 flex-col gap-2 ${compact ? TOUCH_TARGETS : ''} ${className ?? ''}`}
    >
      {bulk.offered && (
        <Button
          size="sm"
          className="self-start"
          data-testid="approve-all"
          disabled={bulk.sending.size > 0}
          title={bulk.title}
          onClick={() => void bulk.approveAll()}
        >
          <Icons.CheckCheck aria-hidden size={13} />
          Approve all ({bulk.approvable.length})
        </Button>
      )}
      {requests.map((request, index) => (
        <ApprovalRow
          key={request.id}
          request={request}
          keyboard={keyboard && index === 0}
          approvingAll={bulk.sending.has(request.id)}
        />
      ))}
    </div>
  );
}

/**
 * D391: an approval Approve all never answers — the engine's `destructive_action` check asked
 * about it (Arch §13.1: destructive always asks), or it is a command on the risky-command list
 * (D376).
 */
export function isDestructiveApproval(request: ApprovalRequest): boolean {
  return request.checkType === 'destructive_action' || request.command?.denylisted === true;
}

/** What one waiting approval is called in the Approve all tooltip: its node, and its tool if any. */
function approvalName(request: ApprovalRequest): string {
  const tool = destructiveTool(request)?.toolName;
  return tool === undefined ? request.nodeName : `${request.nodeName} (${tool})`;
}

/**
 * D391: Approve all for one stack. `approvable` is every non-destructive run approval, oldest
 * first (the stack's order); a chat turn's (no node run) is answered in its chat. It is offered
 * only when two or more are waiting and two or more of them are approvable — one would be the
 * card's own Approve. Each is approved in turn with the per-approval mutation; one that fails
 * (decided elsewhere a moment ago, say) does not stop the rest, and the failures are said once.
 * The frames take the cards down, as for a single Approve.
 */
function useApproveAll(requests: readonly ApprovalRequest[]) {
  const approve = useApproveNodeRun();
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const approvable = requests.filter(
    (request) => !isDestructiveApproval(request) && request.nodeRunId !== undefined,
  );
  const leftForYou = requests.filter(isDestructiveApproval);
  const offered = requests.length >= 2 && approvable.length >= 2;
  const title =
    leftForYou.length === 0
      ? `Approve all ${approvable.length}, oldest first`
      : `Approve the ${approvable.length} that are not destructive, oldest first. Left for you to decide: ${leftForYou.map(approvalName).join(', ')}`;

  const approveAll = async (): Promise<void> => {
    const batch = approvable;
    setSending(new Set(batch.map((request) => request.id)));
    const failed: string[] = [];
    for (const request of batch) {
      try {
        await approve.mutateAsync({ nodeRunId: request.nodeRunId ?? '' });
      } catch (error) {
        failed.push(`${request.nodeName}: ${error instanceof Error ? error.message : 'not sent'}`);
      }
    }
    setSending(new Set());
    if (failed.length > 0) {
      toast.error(
        `${failed.length} of ${batch.length} approvals were not sent — ${failed.join('; ')}`,
      );
    }
  };

  return { offered, approvable, title, sending, approveAll };
}

function ApprovalRow({
  request,
  keyboard,
  approvingAll = false,
}: {
  request: ApprovalRequest;
  keyboard: boolean;
  /** D391: Approve all is sending this one's approval right now. */
  approvingAll?: boolean;
}) {
  const approve = useApproveNodeRun();
  const reject = useRejectNodeRun();
  const [note, setNote] = useState('');
  const [decided, setDecided] = useState<'approve' | 'reject'>();

  /*
   * The decision is remembered locally only so the card can say what was chosen in the moment
   * between the POST and `node.approval_decided` arriving. The frame is what removes the card.
   */
  const decide = (kind: 'approve' | 'reject', always = false) => {
    setDecided(kind);
    const variables = {
      nodeRunId: request.nodeRunId ?? '',
      ...(always && kind === 'approve' ? { always: true as const } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    const mutation = kind === 'approve' ? approve : reject;
    mutation.mutate(variables, { onError: () => setDecided(undefined) });
  };

  const tool = destructiveTool(request);
  // D328: the node keeps one colour everywhere; without a known workflow the accent stands in.
  const workflowId = useRunStore((store) => store.workflowId);
  const graph = useWorkflowGraph(workflowId);
  const nodeColor =
    request.command === undefined
      ? undefined
      : agentMap(graph.data?.nodes ?? []).get(request.nodeId)?.color;

  return (
    <div className="flex w-full flex-col gap-1.5">
      {tool !== undefined && <DestructiveToolPreview toolName={tool.toolName} args={tool.args} />}
      <ApprovalCard
        className="w-full max-w-none"
        request={request}
        pending={approve.isPending || reject.isPending || approvingAll}
        {...(decided === undefined
          ? approvingAll
            ? { decided: 'approve' as const }
            : {}
          : { decided })}
        note={note}
        onNoteChange={setNote}
        keyboard={keyboard}
        onApprove={() => decide('approve')}
        onReject={() => decide('reject')}
        onApproveAlways={() => decide('approve', true)}
        {...(nodeColor === undefined ? {} : { nodeColor })}
      />
    </div>
  );
}

/**
 * A destructive tool call the agent wants to make, named plainly above the card (round 4 §5 item 8,
 * FR-GRD-006, BR-14). The engine's `destructive_action` check puts the call in the request `preview`
 * as `<tool_name> <args-json>` (`APPROVAL_PREVIEW_MAX`), so what a person is being asked to allow —
 * `sandbox_delete` on `notes.txt`, say — is the first thing they read, not something to decode from
 * the raw preview line. Returns `undefined` for any non-destructive approval, which renders the card
 * alone exactly as before.
 */
function destructiveTool(request: ApprovalRequest): { toolName: string; args: string } | undefined {
  if (request.point !== 'tool' || request.checkType !== 'destructive_action') return undefined;
  const preview = request.preview.trim();
  const space = preview.indexOf(' ');
  const toolName = space === -1 ? preview : preview.slice(0, space);
  if (!TOOL_NAME_REGEX.test(toolName)) return undefined;
  return { toolName, args: space === -1 ? '' : preview.slice(space + 1).trim() };
}

/** The theme's red card: a surface card, radius 12, its header strip in `#c94c27` at 10% (D328). */
function DestructiveToolPreview({ toolName, args }: { toolName: string; args: string }) {
  return (
    <div
      data-testid="approval-tool-preview"
      className="flex flex-col overflow-hidden rounded-[12px] border border-[rgba(201,76,39,0.35)] bg-[var(--surface)] pb-[12px] text-[12.5px] text-[var(--ink)]"
    >
      <p className="m-0 flex items-center gap-2 border-b border-[rgba(201,76,39,0.25)] bg-[rgba(201,76,39,0.10)] px-[14px] py-[8px]">
        <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#c94c27]" />
        <span className="font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-danger">
          destructive tool call
        </span>
      </p>
      <p className="m-0 px-[14px] pt-[10px]">
        <span className="text-[var(--muted)]">tool </span>
        <span data-testid="approval-tool-name" className="font-machine text-[12px]">
          {toolName}
        </span>
      </p>
      {args !== '' && (
        <pre
          data-testid="approval-tool-args"
          className="mx-[14px] mt-[8px] overflow-auto rounded-[8px] border border-[var(--line)] bg-[var(--soft)] px-[10px] py-[8px] font-machine text-[11px] text-[var(--muted)]"
        >
          {args}
        </pre>
      )}
    </div>
  );
}
