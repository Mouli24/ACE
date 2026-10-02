import type { UsageGroupBy } from '@ace/contracts';

/**
 * The one place usage numbers become text (FR-OBS-002, FR-OBS-004). The table, the cards, the chart
 * and the top-bar chip all format through here, so a cell can be checked against `GET /usage` by
 * formatting the API's own number (TC-OBS-004).
 */

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/**
 * Up to six decimals — the precision the price table works in — so no cost is rounded away on
 * screen; at least two, so whole cents read as money.
 */
const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export type UsageMetric = 'tokensIn' | 'tokensOut' | 'costUsd' | 'runs';

export function formatTokens(value: number): string {
  return integer.format(value);
}

export function formatUsd(value: number): string {
  return usd.format(value);
}

/** `1.2K` — for the top bar, where room is short. The exact number is in its label. */
export function formatCompact(value: number): string {
  return compact.format(value);
}

export function formatUsageValue(metric: UsageMetric, value: number): string {
  return metric === 'costUsd' ? formatUsd(value) : formatTokens(value);
}

export const USAGE_METRIC_LABEL: Readonly<Record<UsageMetric, string>> = {
  tokensIn: 'Tokens in',
  tokensOut: 'Tokens out',
  costUsd: 'Cost (USD)',
  runs: 'Runs',
};

export const USAGE_GROUP_LABEL: Readonly<Record<UsageGroupBy, string>> = {
  provider: 'Provider',
  model: 'Model',
  day: 'Day',
  workflow: 'Workflow',
};

const DAY_MS = 86_400_000;

/** Midnight UTC of the day `now` falls on — the day `usage.updated`'s day totals count (D234). */
export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function addUtcDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * DAY_MS);
}

/** `YYYY-MM-DD` of a UTC instant. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
