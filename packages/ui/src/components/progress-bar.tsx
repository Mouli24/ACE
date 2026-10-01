import { cn } from '../lib/cn.js';

/**
 * A progress bar (ingest progress, FR-RAG-002; onboarding steps, FR-ONB-002). `value` undefined is
 * indeterminate: no `aria-valuenow`, and a third-width bar that pulses only when motion is allowed
 * (`motion-safe:`, NFR-USE-02).
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
        className="relative h-1.5 flex-1 overflow-hidden rounded-chip bg-border"
        data-testid="progress-bar"
      >
        <div
          className={cn(
            'h-full rounded-chip transition-[width]',
            tone === 'danger' ? 'bg-danger' : 'bg-accent',
            percent === undefined && 'w-1/3 motion-safe:animate-pulse',
          )}
          style={percent === undefined ? undefined : { width: `${percent}%` }}
        />
      </div>
      {showValue && percent !== undefined ? (
        <span className="w-9 text-right font-machine text-[11px] text-fg-muted">{percent}%</span>
      ) : null}
    </div>
  );
}
