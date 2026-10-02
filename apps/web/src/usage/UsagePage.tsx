import {
  USAGE_GROUP_BY,
  type UsageBucket,
  type UsageGroupBy,
  type UsageResponse,
} from '@ace/contracts';
import { BarChart, Button, Checkbox, Input, Label, cn, type BarChartSeries } from '@ace/ui';
import { useId, useState, type ReactNode } from 'react';

import {
  USAGE_GROUP_LABEL,
  USAGE_METRIC_LABEL,
  addUtcDays,
  formatTokens,
  formatUsageValue,
  formatUsd,
  startOfUtcDay,
  utcDate,
  type UsageMetric,
} from './format';
import { useProviderNames, useRefreshUsageOnRunEnd, useUsage, useWorkflowNames } from './hooks';
import { PRESETS, usageRange, type Preset } from './range';

/**
 * `/usage` — spend and tokens by provider, model, day and workflow (FR-OBS-004, D239).
 *
 * Every number on the screen is a number `GET /usage` answered, passed through one formatter
 * (`format.ts`); nothing is summed or rounded here, and the totals row is the response's own
 * `totals` (TC-OBS-004). Each cell also carries the raw value in `data-value`, and each key cell the
 * raw key in `data-key`, so the table can be compared with the API cell by cell.
 *
 * At narrow widths the table becomes one card per bucket, so the page never scrolls sideways at
 * 380 px (NFR-USE-03); the chart switches to horizontal bars by itself.
 */

const METRICS: readonly UsageMetric[] = ['tokensIn', 'tokensOut', 'costUsd', 'runs'];

type ChartMode = 'cost' | 'tokens';

const COST_SERIES: readonly BarChartSeries[] = [{ key: 'costUsd', label: 'Cost (USD)' }];
const TOKEN_SERIES: readonly BarChartSeries[] = [
  { key: 'tokensIn', label: 'Tokens in' },
  { key: 'tokensOut', label: 'Tokens out' },
];

export function UsagePage() {
  useRefreshUsageOnRunEnd();
  const [preset, setPreset] = useState<Preset>('7d');
  const [custom, setCustom] = useState(() => {
    const today = startOfUtcDay();
    return { from: utcDate(addUtcDays(today, -6)), to: utcDate(today) };
  });
  const [groupBy, setGroupBy] = useState<readonly UsageGroupBy[]>(['provider']);
  const [chart, setChart] = useState<ChartMode>('cost');

  const range = usageRange(preset, custom);
  const usage = useUsage(range, groupBy);
  const providerNames = useProviderNames();
  const workflowNames = useWorkflowNames(groupBy.includes('workflow'));

  const keyLabel = (by: UsageGroupBy, raw: string): string => {
    if (raw === '') return '—';
    if (by === 'provider') return providerNames.get(raw) ?? raw;
    if (by === 'workflow') return workflowNames.get(raw) ?? raw;
    return raw;
  };

  const toggleGroup = (by: UsageGroupBy, on: boolean) =>
    setGroupBy((current) => USAGE_GROUP_BY.filter((g) => (g === by ? on : current.includes(g))));

  const fromId = useId();
  const toId = useId();

  return (
    <main
      data-testid="usage-page"
      className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6"
    >
      <h1 className="font-human text-2xl font-semibold">Usage</h1>

      <section
        aria-label="Filters"
        className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-panel p-4"
      >
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Date range (UTC)
          </legend>
          <div className="flex flex-wrap gap-1.5" data-testid="usage-presets">
            {PRESETS.map((p) => (
              <Button
                key={p.id}
                type="button"
                size="sm"
                variant={preset === p.id ? 'default' : 'outline'}
                aria-pressed={preset === p.id}
                data-testid={`usage-preset-${p.id}`}
                onClick={() => setPreset(p.id)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor={fromId}>From</Label>
                <Input
                  id={fromId}
                  type="date"
                  className="w-40"
                  data-testid="usage-from"
                  value={custom.from}
                  onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={toId}>To (inclusive)</Label>
                <Input
                  id={toId}
                  type="date"
                  className="w-40"
                  data-testid="usage-to"
                  value={custom.to}
                  onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                />
              </div>
              {range === undefined && (
                <p role="alert" className="text-xs text-[var(--color-status-FAILED)]">
                  The first day must be on or before the last.
                </p>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Group by
          </legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2" data-testid="usage-group-by">
            {USAGE_GROUP_BY.map((by) => {
              const checked = groupBy.includes(by);
              const id = `usage-group-${by}`;
              return (
                <div key={by} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    data-testid={id}
                    checked={checked}
                    // at least one grouping, always (D234)
                    disabled={checked && groupBy.length === 1}
                    onCheckedChange={(value) => toggleGroup(by, value === true)}
                  />
                  <label htmlFor={id} className="text-sm">
                    {USAGE_GROUP_LABEL[by]}
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
      </section>

      {usage.isError ? (
        <p role="alert" className="text-sm text-[var(--color-status-FAILED)]">
          Could not load usage: {usage.error.message}
        </p>
      ) : usage.data === undefined ? (
        range !== undefined && <p className="text-sm text-fg-muted">Loading usage…</p>
      ) : (
        <UsageResult
          data={usage.data}
          groupBy={groupBy}
          keyLabel={keyLabel}
          chart={chart}
          onChart={setChart}
        />
      )}
    </main>
  );
}

function UsageResult({
  data,
  groupBy,
  keyLabel,
  chart,
  onChart,
}: {
  data: UsageResponse;
  groupBy: readonly UsageGroupBy[];
  keyLabel: (by: UsageGroupBy, raw: string) => string;
  chart: ChartMode;
  onChart: (mode: ChartMode) => void;
}) {
  const rowLabel = (bucket: UsageBucket) =>
    groupBy.map((by) => keyLabel(by, bucket.key[by] ?? '')).join(' · ');

  return (
    <>
      <section
        aria-labelledby="usage-chart-heading"
        data-testid="usage-chart-panel"
        className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-panel p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="usage-chart-heading" className="font-human text-sm font-semibold">
            {chart === 'cost' ? 'Cost' : 'Tokens'} by{' '}
            {groupBy.map((b) => USAGE_GROUP_LABEL[b].toLowerCase()).join(', ')}
          </h2>
          <div className="ml-auto flex gap-1" role="group" aria-label="Chart shows">
            {(['cost', 'tokens'] as const).map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={chart === mode ? 'default' : 'outline'}
                aria-pressed={chart === mode}
                data-testid={`usage-chart-${mode}`}
                onClick={() => onChart(mode)}
              >
                {mode === 'cost' ? 'Cost' : 'Tokens'}
              </Button>
            ))}
          </div>
        </div>
        <BarChart
          ariaLabel={chart === 'cost' ? 'Cost by group' : 'Tokens by group'}
          data={data.buckets.map((bucket) => ({
            label: rowLabel(bucket),
            values: chartValues(chart, bucket),
          }))}
          series={chart === 'cost' ? COST_SERIES : TOKEN_SERIES}
          format={chart === 'cost' ? formatUsd : formatTokens}
          stacked={chart === 'tokens'}
        />
      </section>

      <section aria-labelledby="usage-table-heading" className="flex min-w-0 flex-col gap-2">
        <h2 id="usage-table-heading" className="font-human text-sm font-semibold">
          Breakdown
        </h2>
        {data.buckets.length === 0 && (
          <p className="text-sm text-fg-muted" data-testid="usage-empty">
            No usage in this range.
          </p>
        )}

        {/* ≥ 640 px: one table; it scrolls inside its own box only if the columns cannot fit. */}
        <div className="hidden min-w-0 overflow-x-auto rounded-card border border-border bg-panel sm:block">
          <table className="w-full text-sm" data-testid="usage-table">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-muted">
                {groupBy.map((by) => (
                  <th key={by} scope="col" className="px-3 py-2 font-medium">
                    {USAGE_GROUP_LABEL[by]}
                  </th>
                ))}
                {METRICS.map((metric) => (
                  <th key={metric} scope="col" className="px-3 py-2 text-right font-medium">
                    {USAGE_METRIC_LABEL[metric]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((bucket, i) => (
                <tr key={i} data-testid={`usage-row-${i}`} className="border-b border-border/60">
                  {groupBy.map((by) => (
                    <KeyCell key={by} by={by} raw={bucket.key[by] ?? ''} label={keyLabel} />
                  ))}
                  {METRICS.map((metric) => (
                    <ValueCell key={metric} metric={metric} value={bucket[metric]} />
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr data-testid="usage-totals" className="font-semibold">
                <th scope="row" colSpan={groupBy.length} className="px-3 py-2 text-left">
                  Total
                </th>
                <ValueCell metric="tokensIn" value={data.totals.tokensIn} />
                <ValueCell metric="tokensOut" value={data.totals.tokensOut} />
                <ValueCell metric="costUsd" value={data.totals.costUsd} />
                <td className="px-3 py-2 text-right text-fg-muted">—</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* < 640 px: a card per bucket, the same numbers through the same formatter. */}
        <ul className="flex min-w-0 flex-col gap-2 sm:hidden" data-testid="usage-cards">
          {data.buckets.map((bucket, i) => (
            <UsageCard key={i} testId={`usage-card-${i}`} title={rowLabel(bucket)}>
              {METRICS.map((metric) => (
                <CardValue key={metric} metric={metric} value={bucket[metric]} />
              ))}
            </UsageCard>
          ))}
          <UsageCard testId="usage-card-totals" title="Total" strong>
            <CardValue metric="tokensIn" value={data.totals.tokensIn} />
            <CardValue metric="tokensOut" value={data.totals.tokensOut} />
            <CardValue metric="costUsd" value={data.totals.costUsd} />
          </UsageCard>
        </ul>
      </section>
    </>
  );
}

function chartValues(chart: ChartMode, bucket: UsageBucket): Record<string, number> {
  return chart === 'cost'
    ? { costUsd: bucket.costUsd }
    : { tokensIn: bucket.tokensIn, tokensOut: bucket.tokensOut };
}

function KeyCell({
  by,
  raw,
  label,
}: {
  by: UsageGroupBy;
  raw: string;
  label: (by: UsageGroupBy, raw: string) => string;
}) {
  const text = label(by, raw);
  return (
    <td
      className="max-w-[16rem] truncate px-3 py-2"
      data-testid={`usage-key-${by}`}
      data-key={raw}
      title={text === raw ? undefined : raw}
    >
      {text}
    </td>
  );
}

function ValueCell({ metric, value }: { metric: UsageMetric; value: number }) {
  return (
    <td
      className="whitespace-nowrap px-3 py-2 text-right font-machine tabular-nums"
      data-testid={`usage-${metric}`}
      data-value={String(value)}
    >
      {formatUsageValue(metric, value)}
    </td>
  );
}

function UsageCard({
  testId,
  title,
  strong = false,
  children,
}: {
  testId: string;
  title: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      data-testid={testId}
      className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-panel p-3"
    >
      <p className={cn('break-words text-sm', strong && 'font-semibold')}>{title}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">{children}</dl>
    </li>
  );
}

function CardValue({ metric, value }: { metric: UsageMetric; value: number }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[11px] uppercase tracking-wide text-fg-muted">
        {USAGE_METRIC_LABEL[metric]}
      </dt>
      <dd
        className="break-all font-machine text-sm tabular-nums"
        data-testid={`usage-card-${metric}`}
        data-value={String(value)}
      >
        {formatUsageValue(metric, value)}
      </dd>
    </div>
  );
}
