import { addUtcDays, startOfUtcDay } from './format';
import type { UsageRange } from './hooks';

export type Preset = 'today' | '7d' | '30d' | 'custom';

export const PRESETS: readonly { id: Preset; label: string; days: number }[] = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: 'custom', label: 'Custom', days: 0 },
];

/**
 * The query range: `from` inclusive and `to` exclusive, both midnight UTC (D234). A preset of N
 * days ends with today; a custom range names its last day inclusively, so `to` is the day after.
 */
export function usageRange(
  preset: Preset,
  custom: { from: string; to: string },
  now: Date = new Date(),
): UsageRange | undefined {
  const today = startOfUtcDay(now);
  if (preset !== 'custom') {
    const days = PRESETS.find((p) => p.id === preset)?.days ?? 1;
    return {
      from: addUtcDays(today, 1 - days).toISOString(),
      to: addUtcDays(today, 1).toISOString(),
    };
  }
  const from = Date.parse(`${custom.from}T00:00:00.000Z`);
  const last = Date.parse(`${custom.to}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(last) || last < from) return undefined;
  return {
    from: new Date(from).toISOString(),
    to: addUtcDays(new Date(last), 1).toISOString(),
  };
}
