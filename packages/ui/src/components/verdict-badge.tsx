import type { GuardrailAction, Verdict } from '@ace/contracts';
import { Check, EyeOff, HandHelping, ShieldX, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { GUARDRAIL_ACTION_LABEL } from './approval-card.js';

/** One colour and one icon per guardrail action, so a verdict list is readable without hue alone. */
const ACTION_META: Readonly<Record<GuardrailAction, { Icon: LucideIcon; color: string }>> = {
  pass: { Icon: Check, color: 'var(--color-status-COMPLETED)' },
  warn: { Icon: TriangleAlert, color: 'var(--color-status-WAITING)' },
  redact: { Icon: EyeOff, color: 'var(--color-status-PAUSED)' },
  ask_user: { Icon: HandHelping, color: 'var(--color-status-READY)' },
  block: { Icon: ShieldX, color: 'var(--color-danger)' },
};

export interface VerdictBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  verdict: Verdict;
}

/**
 * One guardrail verdict, as a chip: the action taken, the check that took it, and — for a redaction
 * — the *types* removed and nothing else.
 *
 * FR-GRD-014 is the reason this component exists rather than a generic badge: a redaction verdict
 * must never carry the value it removed. The contract makes that impossible (`Verdict` is strict and
 * has no value field), and this renders only `redactedTypes`, so neither layer can leak it.
 */
export function VerdictBadge({ verdict, className, ...props }: VerdictBadgeProps) {
  const meta = ACTION_META[verdict.action];
  return (
    <span
      data-testid={`verdict-${verdict.id}`}
      data-action={verdict.action}
      data-point={verdict.point}
      data-passed={verdict.passed ? 'true' : 'false'}
      title={verdict.reason}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-chip border border-border bg-card px-2 py-0.5 font-machine text-[11px]',
        className,
      )}
      {...props}
    >
      <meta.Icon className="h-3 w-3 shrink-0" style={{ color: meta.color }} aria-hidden />
      <span style={{ color: meta.color }}>{GUARDRAIL_ACTION_LABEL[verdict.action]}</span>
      <span className="text-fg-muted">{verdict.checkType}</span>
      <span className="text-fg-muted">· {verdict.point}</span>
      {verdict.redactedTypes !== undefined && verdict.redactedTypes.length > 0 && (
        <span data-testid={`verdict-redacted-${verdict.id}`} className="text-fg-muted">
          · removed {verdict.redactedTypes.join(', ')}
        </span>
      )}
    </span>
  );
}
