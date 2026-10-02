import type { UsageResponse } from '@ace/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { formatCompact, formatTokens, formatUsd, startOfUtcDay, utcDate } from './format';
import { useUsage, usageQueryKey, usageRootKey } from './hooks';
import { useSocketFrames } from './live';

/**
 * Today's tokens and cost across every run, in the top bar (FR-OBS-002). "Today" is the UTC day,
 * the one the daily budget and `usage.updated`'s day totals count (D234).
 *
 * Read from `GET /usage` grouped by day from midnight UTC; when a run completes the engine's
 * `usage.updated` carries the day totals (§2.8, D233) and they are written straight into the cache,
 * and `run.completed` refetches in case that frame was not seen. The chip hides below `lg`, where
 * the top bar has no room; the usage icon beside it still links to `/usage`.
 */
export function DayTotalsChip() {
  const queryClient = useQueryClient();
  const day = startOfUtcDay();
  const range = { from: day.toISOString() };
  const groupBy = ['day'] as const;
  const usage = useUsage(range, groupBy);

  useSocketFrames(['usage.updated', 'run.completed'], (frame) => {
    if (frame.type !== 'usage.updated') {
      void queryClient.invalidateQueries({ queryKey: usageRootKey });
      return;
    }
    const totals = frame.payload.dayTotals;
    if (totals === undefined || totals.day !== utcDate(day)) return;
    queryClient.setQueryData<UsageResponse>(usageQueryKey(range, groupBy), (current) => ({
      buckets: current?.buckets ?? [],
      totals: totals.totals,
    }));
  });

  if (usage.data === undefined) return null;
  const { tokensIn, tokensOut, costUsd } = usage.data.totals;
  const tokens = tokensIn + tokensOut;

  return (
    <Link
      to="/usage"
      data-testid="day-totals-chip"
      data-tokens={String(tokens)}
      data-cost={String(costUsd)}
      aria-label={`Today: ${formatTokens(tokens)} tokens, ${formatUsd(costUsd)}. Open usage`}
      title={`Today (UTC): ${formatTokens(tokensIn)} in · ${formatTokens(tokensOut)} out · ${formatUsd(costUsd)}`}
      className="hidden shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 py-0.5 font-machine text-[11px] text-fg-muted hover:text-fg lg:inline-flex"
    >
      Today: {formatCompact(tokens)} tok · {formatUsd(costUsd)}
    </Link>
  );
}
