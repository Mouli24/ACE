import { AceApiError } from '@ace/sdk';
import { Button, cn } from '@ace/ui';

import { errorMessage } from './query-client';

/**
 * Audit U-2/U-9: a read that failed, said as it is — the engine's words, Retry, and when the
 * engine could not be reached at all, where to look. Not "not found": that is the engine's 404
 * only. `className` places it (Home centres it, a page pads it).
 */
export function QueryError({
  what,
  error,
  onRetry,
  className,
}: {
  /** What could not be loaded, as it reads after "Could not load": "projects", "this workflow". */
  what: string;
  error: unknown;
  onRetry: () => void;
  className?: string;
}) {
  const unreachable = !AceApiError.is(error) || error.status === 0;
  return (
    <div
      role="alert"
      data-testid="query-error"
      className={cn('flex flex-col gap-2 text-[13px] leading-[1.5]', className)}
    >
      <p className="text-[var(--danger-ink)]">
        Could not load {what}: {errorMessage(error)}
      </p>
      {unreachable && (
        <p className="text-[12px] text-[var(--muted)]">
          Is the engine running? Start it again (
          <code className="rounded-[4px] bg-[var(--hover)] px-[5px] py-px font-machine text-[11px] text-[var(--ink)]">
            pnpm dev
          </code>
          ), then retry.
        </p>
      )}
      <div>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
