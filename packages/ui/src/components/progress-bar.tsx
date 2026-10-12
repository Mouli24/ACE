import { cn } from '../lib/cn.js';

/**
 * A progress bar (ingest progress, FR-RAG-002; onboarding steps, FR-ONB-002). `value` undefined is
 * indeterminate: no `aria-valuenow`, and a third-width bar that pulses only when motion is allowed
 * (`motion-safe:`, NFR-USE-02).
 *
 * In the theme (D328) it is the token bar of Domain's agent cards: a 4px track in `--hover`, radius
 * 2, filled in the accent `#ef6b3f` (red `#c94c27` for `danger`), easing its width over .6s.
 */

export interface ProgressBarProps {
  /** 0..max; omit for indeterminate. Clamped. */
  value?: number;
  max?: number;
  /** Accessible name. */
  label: string;
  /** Show the percentage beside the bar. */
  showValue?: boolean;
  tone?: 'accent' | 'danger';
  className?: string;
}

export function ProgressBar({
  value,
  max = 100,
  label,
  showValue = false,
  tone = 'accent',
  className,
}: ProgressBarProps) {
  const safeMax = max > 0 ? max : 100;
  const clamped = value === undefined ? undefined : Math.min(safeMax, Math.max(0, value));
  const percent = clamped === undefined ? undefined : Math.round((clamped / safeMax) * 100);

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={clamped}
        aria-valuetext={percent === undefined ? 'In progress' : `${percent}%`}
        className="relative h-[4px] flex-1 overflow-hidden rounded-[2px] bg-[var(--hover)]"
        data-testid="progress-bar"
      >
        <div
          className={cn(
            'h-full rounded-[2px] transition-[width] duration-[600ms] ease-[ease]',
            tone === 'danger' ? 'bg-[#c94c27]' : 'bg-[#ef6b3f]',
            percent === undefined &&
              'w-1/3 motion-safe:animate-[livePulse_1.4s_ease-in-out_infinite]',
          )}
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
      {showValue && percent !== undefined ? (
        <span className="w-9 text-right font-machine text-[10px] text-[var(--muted)]">
          {percent}%
        </span>
      ) : null}
    </div>
  );
}
