import type { GuardrailAction, Verdict } from '@ace/contracts';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';
import { GUARDRAIL_ACTION_LABEL } from './approval-card.js';

/**
 * One colour and one glyph per guardrail action, so a verdict list is readable without hue alone.
 * The colours are the theme's status set (D328) — done green, accent, muted, stage purple, red — and
 * each chip is that colour on itself at 12% (`colour + '1f'`); muted uses the theme's quiet pill.
 */
const ACTION_META: Readonly<
  Record<GuardrailAction, { glyph: string; color: string; fill: string }>
> = {
  pass: { glyph: '✓', color: '#2f9e63', fill: '#2f9e631f' },
  warn: { glyph: '!', color: '#e8572e', fill: '#ef6b3f1f' },
  redact: { glyph: '▬', color: 'var(--muted)', fill: 'var(--hover)' },
  ask_user: { glyph: '✋', color: '#7a62d6', fill: '#7a62d61f' },
  block: { glyph: '✕', color: '#c94c27', fill: '#c94c271f' },
};

export interface VerdictBadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  verdict: Verdict;
}

/**
 * One guardrail verdict, as the theme's mono chip: the action taken, the check that took it, and —
 * for a redaction — the *types* removed and nothing else.
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
        'inline-flex max-w-full flex-wrap items-center gap-x-[5px] rounded-[4px] px-[6px] py-[2px] font-machine text-[8.5px] font-medium uppercase leading-[1.4] tracking-[0.08em]',
        className,
      )}
      style={{ background: meta.fill }}
      {...props}
    >
      <span aria-hidden data-glyph={meta.glyph} style={{ color: meta.color }}>
        {meta.glyph}
      </span>
      <span style={{ color: meta.color }}>{GUARDRAIL_ACTION_LABEL[verdict.action]}</span>
      <span className="text-[var(--muted)]">{verdict.checkType}</span>
      <span className="text-[var(--muted)]">· {verdict.point}</span>
      {verdict.redactedTypes !== undefined && verdict.redactedTypes.length > 0 && (
        <span data-testid={`verdict-redacted-${verdict.id}`} className="text-[var(--muted)]">
          · removed {verdict.redactedTypes.join(', ')}
        </span>
      )}
    </span>
  );
}
