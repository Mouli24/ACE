import { GUARDRAIL_ACTIONS, type ApprovalRequest, type GuardrailAction } from '@ace/contracts';
import { ShieldAlert } from 'lucide-react';
import { useEffect, type HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from './button.js';

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
        'flex w-full max-w-sm flex-col gap-2.5 rounded-card border border-[color-mix(in_oklab,var(--color-status-WAITING)_60%,transparent)] bg-panel p-3.5 shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-status-WAITING)_10%,transparent),0_18px_40px_-16px_#000000aa]',
        className,
      )}
      {...props}
    >
      <header className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] bg-[color-mix(in_oklab,var(--color-status-WAITING)_16%,transparent)] text-[var(--color-status-WAITING)]"
        >
          <ShieldAlert className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate font-human text-[15px] font-semibold">{request.nodeName}</p>
          <p className="font-machine text-[9.5px] text-fg-muted">
            {request.point} · {request.checkType} · ask user
          </p>
        </div>
      </header>

      <p className="text-[13.5px] text-fg-soft" data-testid="approval-reason">
        {request.reason}
      </p>

      <pre
        data-testid="approval-preview"
        className="max-h-[76px] overflow-auto whitespace-pre-wrap rounded-[9px] border border-border bg-sunken px-2.5 py-2 font-machine text-[10.5px] text-fg-muted"
      >
        {request.preview}
      </pre>

      {decided === undefined ? (
        <>
          <label className="flex flex-col gap-1 text-[10px] uppercase tracking-wide text-fg-muted">
            Note (optional)
            <input
              className="rounded-field border border-border bg-card px-2 py-1 font-human text-xs text-fg focus-visible:border-selection focus-visible:outline-none"
              value={note ?? ''}
              onChange={(event) => onNoteChange?.(event.target.value)}
              aria-label="Decision note"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={onApprove}>
              Approve <kbd className="ml-1 font-machine text-[10px] opacity-70">A</kbd>
            </Button>
            <Button size="sm" variant="destructive" disabled={pending} onClick={onReject}>
              Reject <kbd className="ml-1 font-machine text-[10px] opacity-70">R</kbd>
            </Button>
          </div>
        </>
      ) : (
        <p
          role="status"
          data-testid="approval-decision"
          data-decision={decided}
          className="font-machine text-xs"
        >
          {decided === 'approve' ? 'Approved — the node continues.' : 'Rejected — the node failed.'}
        </p>
      )}
    </section>
  );
}
