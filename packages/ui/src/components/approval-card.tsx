import { GUARDRAIL_ACTIONS, type ApprovalRequest, type GuardrailAction } from '@ace/contracts';
import { useEffect, type HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from './button.js';
import { INPUT_CLASS } from './input.js';
import { FIELD_LABEL_CLASS } from './label.js';

/**
 * Labels for the five guardrail actions (FR-GRD-011). `ask_user` reads "ask user" everywhere a
 * person sees it, while the enum value stays the contract's `ask_user` (CLAUDE.md §7).
 */
export const GUARDRAIL_ACTION_LABEL: Readonly<Record<GuardrailAction, string>> = {
  pass: 'pass',
  warn: 'warn',
  redact: 'redact',
  ask_user: 'ask user',
  block: 'block',
};

/** Every action has a label, or a policy editor would render a blank option. */
export const guardrailActionLabels = (): Array<{ value: GuardrailAction; label: string }> =>
  GUARDRAIL_ACTIONS.map((action) => ({ value: action, label: GUARDRAIL_ACTION_LABEL[action] }));

export interface ApprovalCardProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
  request: ApprovalRequest;
  /** Disabled while a decision is in flight, so neither button can be pressed twice. */
  pending?: boolean;
  /** The decision already taken, if any — the card then reports it instead of asking again. */
  decided?: 'approve' | 'reject';
  /**
   * Whether `A` and `R` act on this card. Default true; a stack of cards gives it to the top one
   * only, or one key press would answer two questions.
   */
  keyboard?: boolean;
  note?: string;
  onNoteChange?: (note: string) => void;
  onApprove: () => void;
  onReject: () => void;
}

/**
 * What an `ask_user` guardrail puts in front of the person while the node waits (FR-GRD-013).
 *
 * It states four things, because a decision needs all of them: which node stopped, which check at
 * which point stopped it, why, and what the content actually was. The preview is the engine's own
 * truncation (`APPROVAL_PREVIEW_MAX`), shown as-is.
 *
 * `A` approves and `R` rejects while the card is mounted (FR-GRD-013's keyboard path). The layout is
 * a single column with wrapping buttons so it stays usable at 380 px (FR-MOB-002).
 *
 * The look is the theme's output card (D328) in its accent: a surface card, radius 12, whose header
 * strip says "waiting on you" in `rgba(239,107,63,…)`; Approve is the Done pill, Reject the Close
 * pill, and the preview sits in a soft box, radius 8.
 */
export function ApprovalCard({
  request,
  pending = false,
  decided,
  keyboard = true,
  note,
  onNoteChange,
  onApprove,
  onReject,
  className,
  ...props
}: ApprovalCardProps) {
  useEffect(() => {
    if (!keyboard || decided !== undefined || pending) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Never steal a letter the person is typing into the note or anywhere else.
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        onApprove();
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        onReject();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [keyboard, decided, pending, onApprove, onReject]);

  return (
    <section
      data-testid={`approval-card-${request.nodeRunId}`}
      data-point={request.point}
      data-check={request.checkType}
      aria-label={`Approval needed for ${request.nodeName}`}
      className={cn(
        'flex w-full max-w-sm flex-col overflow-hidden rounded-[12px] border border-[rgba(239,107,63,0.35)] bg-[var(--surface)] text-[var(--ink)]',
        className,
      )}
      {...props}
    >
      <header className="flex items-center gap-2 border-b border-[rgba(239,107,63,0.25)] bg-[rgba(239,107,63,0.10)] px-[14px] py-[10px]">
        <span
          aria-hidden
          className={cn(
            'h-[7px] w-[7px] shrink-0 rounded-full bg-[#ef6b3f]',
            decided === undefined && 'motion-safe:animate-[livePulse_1.4s_ease-in-out_infinite]',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold">{request.nodeName}</span>
        <span className="shrink-0 rounded-[4px] bg-[rgba(239,107,63,0.12)] px-[6px] py-[2px] font-machine text-[8.5px] font-medium uppercase tracking-[0.08em] text-[#e8572e]">
          waiting on you
        </span>
      </header>

      <div className="flex flex-col gap-[10px] px-[14px] py-[12px]">
        <p className="font-machine text-[10.5px] text-[var(--muted)]">
          {request.point} · {request.checkType} · ask user
        </p>

        <p className="text-[13px] leading-[1.5]" data-testid="approval-reason">
          {request.reason}
        </p>

        <pre
          data-testid="approval-preview"
          className="max-h-[76px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-[var(--line)] bg-[var(--soft)] px-[10px] py-[8px] font-machine text-[11px] text-[var(--muted)]"
        >
          {request.preview}
        </pre>

        {decided === undefined ? (
          <>
            <label className="flex flex-col gap-[7px]">
              <span className={FIELD_LABEL_CLASS}>Note (optional)</span>
              <input
                className={INPUT_CLASS}
                value={note ?? ''}
                onChange={(event) => onNoteChange?.(event.target.value)}
                aria-label="Decision note"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={pending} onClick={onApprove}>
                Approve <kbd className="font-machine text-[10px] font-normal opacity-60">A</kbd>
              </Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={onReject}>
                Reject <kbd className="font-machine text-[10px] font-normal opacity-60">R</kbd>
              </Button>
            </div>
          </>
        ) : (
          <p
            role="status"
            data-testid="approval-decision"
            data-decision={decided}
            className={cn(
              'text-[12px] font-semibold',
              decided === 'approve' ? 'text-[#2f9e63]' : 'text-[#c94c27]',
            )}
          >
            {decided === 'approve'
              ? 'Approved — the node continues.'
              : 'Rejected — the node failed.'}
          </p>
        )}
      </div>
    </section>
  );
}
