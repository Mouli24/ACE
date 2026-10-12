import type { HaltReason, RunState } from '@ace/contracts';
import { cn } from '@ace/ui';
import type { HTMLAttributes } from 'react';

/**
 * A run state in the Ace UI theme's colours (D328): accent while it runs, done green when complete,
 * red when it halted or was blocked, muted otherwise. `fill` is the colour on itself at 12% — the
 * theme's `colour + '1f'` — and the quiet states use its muted pill (`--hover` under `--muted`).
 */
export const RUN_STATE_LOOK: Readonly<Record<RunState, { color: string; fill: string }>> = {
  PREFLIGHT: { color: 'var(--muted)', fill: 'var(--hover)' },
  RUNNING: { color: '#e8572e', fill: '#ef6b3f1f' },
  PAUSED: { color: 'var(--muted)', fill: 'var(--hover)' },
  COMPLETE: { color: '#2f9e63', fill: '#2f9e631f' },
  BLOCKED: { color: '#c94c27', fill: '#c94c271f' },
  HALTED: { color: '#c94c27', fill: '#c94c271f' },
};

/** The theme's mono chip: 8.5px, 0.08em, radius 4. */
export const CHIP_CLASS =
  'inline-flex items-center gap-1 whitespace-nowrap rounded-[4px] px-[6px] py-[2px] font-machine text-[8.5px] font-medium uppercase leading-[1.4] tracking-[0.08em]';

export interface RunStateChipProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  status: RunState;
  haltReason?: HaltReason;
}

/** A run's status, and why it halted when it did, as one theme chip (FR-EXE-012). */
export function RunStateChip({
  status,
  haltReason,
  className,
  style,
  ...props
}: RunStateChipProps) {
  const look = RUN_STATE_LOOK[status];
  return (
    <span
      data-status={status}
      className={cn(CHIP_CLASS, className)}
      style={{ ...style, color: look.color, background: look.fill }}
      {...props}
    >
      {status}
      {haltReason ? ` · ${haltReason}` : ''}
    </span>
  );
}
