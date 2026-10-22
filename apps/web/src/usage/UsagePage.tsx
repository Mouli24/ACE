import {
  USAGE_GROUP_BY,
  type UsageBucket,
  type UsageGroupBy,
  type UsageResponse,
} from '@ace/contracts';
import {
  BarChart,
  Checkbox,
  FIELD_LABEL_CLASS,
  Input,
  Label,
  cn,
  type BarChartSeries,
} from '@ace/ui';
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
 * 380 px (NFR-USE-03); the chart switches to horizontal bars by itself. An uncovered screen in the
 * Ace UI theme (D328): segmented pills for the range and the chart, theme cards and a theme table.
 */

const METRICS: readonly UsageMetric[] = ['tokensIn', 'tokensOut', 'costUsd', 'runs'];

type ChartMode = 'cost' | 'tokens';

const COST_SERIES: readonly BarChartSeries[] = [{ key: 'costUsd', label: 'Cost (USD)' }];
const TOKEN_SERIES: readonly BarChartSeries[] = [
  { key: 'tokensIn', label: 'Tokens in' },
  { key: 'tokensOut', label: 'Tokens out' },
];

const CARD = 'rounded-[12px] border border-[var(--line)] bg-[var(--surface)]';

/** The theme's segmented control (Ideate / Forge / Domain): a soft track of 26px pills. */
const SEGMENTED =
  'inline-flex max-w-full flex-wrap gap-[2px] rounded-full border border-[var(--line)] bg-[var(--soft)] p-[3px]';

function segment(active: boolean): string {
  return cn(
    'h-[26px] cursor-pointer whitespace-nowrap rounded-full border px-4 text-[12px] font-semibold outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]',
    active
      ? 'border-[var(--seg)] bg-[var(--seg)] text-[var(--segInk)]'
      : 'border-transparent bg-transparent text-[var(--muted)]',
  );
}

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
    <main data-testid="usage-page" className="h-full min-w-0 overflow-y-auto">
      <div className="mx-auto flex w-full min-w-0 max-w-[960px] flex-col gap-6 px-6 py-8">
        <h1 className="text-[20px] font-bold tracking-[-0.01em]">Usage</h1>

        <section aria-label="Filters" className={cn(CARD, 'flex min-w-0 flex-col gap-5 p-4')}>
          <fieldset className="flex min-w-0 flex-col gap-[7px]">
            <legend className={cn(FIELD_LABEL_CLASS, 'mb-[7px]')}>Date range (UTC)</legend>
            <div className={cn(SEGMENTED, 'self-start')} data-testid="usage-presets">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={segment(preset === p.id)}
                  aria-pressed={preset === p.id}
                  data-testid={`usage-preset-${p.id}`}
                  onClick={() => setPreset(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {preset === 'custom' && (
              <div className="mt-2 flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-[7px]">
                  <Label htmlFor={fromId}>From</Label>
                  <Input
                    id={fromId}
                    type="date"
                    className="w-44 font-machine text-[12px]"
                    data-testid="usage-from"
                    value={custom.from}
                    onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-[7px]">
                  <Label htmlFor={toId}>To (inclusive)</Label>
                  <Input
                    id={toId}
                    type="date"
                    className="w-44 font-machine text-[12px]"
                    data-testid="usage-to"
                    value={custom.to}
                    onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  />
                </div>
                {range === undefined && (
                  <p role="alert" className="text-[11px] leading-[1.45] text-danger">
                    The first day must be on or before the last.
                  </p>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="flex min-w-0 flex-col gap-[7px]">
            <legend className={cn(FIELD_LABEL_CLASS, 'mb-[7px]')}>Group by</legend>
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
                    <label htmlFor={id} className="cursor-pointer text-[12.5px]">
                      {USAGE_GROUP_LABEL[by]}
                    </label>
                  </div>
                );
              })}
            </div>
          </fieldset>
        </section>

        {usage.isError ? (
          <p role="alert" className="text-[12px] text-danger">
            Could not load usage: {usage.error.message}
          </p>
        ) : usage.data === undefined ? (
          range !== undefined && <p className="text-[13px] text-[var(--muted)]">Loading usage…</p>
        ) : (
          <UsageResult
            data={usage.data}
            groupBy={groupBy}
            keyLabel={keyLabel}
            chart={chart}
            onChart={setChart}
          />
        )}
      </div>
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
  // PG-4.3: a direct-chat bucket says so; its spend is outside any run.
  const rowLabel = (bucket: UsageBucket) =>
    groupBy.map((by) => keyLabel(by, bucket.key[by] ?? '')).join(' · ') +
    (bucket.source === 'chat' ? ' · chat' : '');
  const hasChat = data.buckets.some((bucket) => bucket.source === 'chat');

  return (
    <>
      <section
        aria-labelledby="usage-chart-heading"
        data-testid="usage-chart-panel"
        className={cn(CARD, 'flex min-w-0 flex-col gap-3 p-4')}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="usage-chart-heading" className="text-[14px] font-bold">
            {chart === 'cost' ? 'Cost' : 'Tokens'} by{' '}
            {groupBy.map((b) => USAGE_GROUP_LABEL[b].toLowerCase()).join(', ')}
          </h2>
          <div className={cn(SEGMENTED, 'ml-auto')} role="group" aria-label="Chart shows">
            {(['cost', 'tokens'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={segment(chart === mode)}
                aria-pressed={chart === mode}
                data-testid={`usage-chart-${mode}`}
                onClick={() => onChart(mode)}
              >
                {mode === 'cost' ? 'Cost' : 'Tokens'}
              </button>
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

      <section aria-labelledby="usage-table-heading" className="flex min-w-0 flex-col gap-3">
        <h2 id="usage-table-heading" className="text-[14px] font-bold">
          Breakdown
        </h2>
        {data.buckets.length === 0 && (
          <p
            className="py-10 text-center text-[13px] text-[var(--muted)]"
            data-testid="usage-empty"
          >
            No usage in this range.
          </p>
        )}

        {/* ≥ 640 px: one table; it scrolls inside its own box only if the columns cannot fit. */}
        <div className={cn(CARD, 'hidden min-w-0 overflow-x-auto sm:block')}>
          <table className="w-full border-collapse text-[12.5px]" data-testid="usage-table">
            <thead>
              <tr className="h-9 text-left font-machine text-[9.5px] uppercase tracking-[0.1em] text-[var(--muted)]">
                {groupBy.map((by) => (
                  <th key={by} scope="col" className="px-3 font-medium">
                    {USAGE_GROUP_LABEL[by]}
                  </th>
                ))}
                {METRICS.map((metric) => (
                  <th key={metric} scope="col" className="px-3 text-right font-medium">
                    {USAGE_METRIC_LABEL[metric]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((bucket, i) => (
                <tr
                  key={i}
                  data-testid={`usage-row-${i}`}
                  className="h-9 border-t border-[var(--line)]"
                >
                  {groupBy.map((by, index) => (
                    <KeyCell
                      key={by}
                      by={by}
                      raw={bucket.key[by] ?? ''}
                      label={keyLabel}
                      chat={index === 0 && bucket.source === 'chat'}
                    />
                  ))}
                  {METRICS.map((metric) => (
                    <ValueCell
                      key={metric}
                      metric={metric}
                      value={bucket[metric]}
                      costKnown={bucket.costKnown}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr
                data-testid="usage-totals"
                className="h-9 border-t border-[var(--line)] font-bold"
              >
                <th scope="row" colSpan={groupBy.length} className="px-3 text-left">
                  Total
                </th>
                <ValueCell metric="tokensIn" value={data.totals.tokensIn} />
                <ValueCell metric="tokensOut" value={data.totals.tokensOut} />
                <ValueCell
                  metric="costUsd"
                  value={data.totals.costUsd}
                  costKnown={data.totals.costKnown}
                />
                <td className="px-3 text-right text-[var(--muted)]">—</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {hasChat && (
          <p className="text-[11px] text-[var(--muted)]" data-testid="usage-chat-note">
            Rows marked chat are direct-chat replies, outside any run; they count in the total.
          </p>
        )}

        {/* < 640 px: a card per bucket, the same numbers through the same formatter. */}
        <ul className="flex min-w-0 flex-col gap-[10px] sm:hidden" data-testid="usage-cards">
          {data.buckets.map((bucket, i) => (
            <UsageCard key={i} testId={`usage-card-${i}`} title={rowLabel(bucket)}>
              {METRICS.map((metric) => (
                <CardValue
                  key={metric}
                  metric={metric}
                  value={bucket[metric]}
                  costKnown={bucket.costKnown}
                />
              ))}
            </UsageCard>
          ))}
          <UsageCard testId="usage-card-totals" title="Total" strong>
            <CardValue metric="tokensIn" value={data.totals.tokensIn} />
            <CardValue metric="tokensOut" value={data.totals.tokensOut} />
            <CardValue
              metric="costUsd"
              value={data.totals.costUsd}
              costKnown={data.totals.costKnown}
            />
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
  chat = false,
}: {
  by: UsageGroupBy;
  raw: string;
  label: (by: UsageGroupBy, raw: string) => string;
  /** PG-4.3: the row is direct-chat spend. */
  chat?: boolean;
}) {
  const text = label(by, raw);
  return (
    <td
      className="max-w-[16rem] truncate px-3"
      data-testid={`usage-key-${by}`}
      data-key={raw}
      title={text === raw ? undefined : raw}
    >
      {text}
      {chat && (
        <span
          data-testid="usage-source-chat"
          className="ml-2 rounded-full border border-[var(--line)] px-[6px] py-[1px] font-machine text-[9.5px] text-[var(--muted)]"
        >
          chat
        </span>
      )}
    </td>
  );
}

function ValueCell({
  metric,
  value,
  costKnown,
}: {
  metric: UsageMetric;
  value: number;
  /** PG-4.3 (D359): `false` — the cost is only its known part. */
  costKnown?: boolean | undefined;
}) {
  return (
    <td
      className="whitespace-nowrap px-3 text-right font-machine text-[12px] tabular-nums"
      data-testid={`usage-${metric}`}
      data-value={String(value)}
      {...(metric === 'costUsd' && costKnown === false ? { 'data-cost-known': 'false' } : {})}
    >
      {formatUsageValue(metric, value, costKnown)}
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
    <li data-testid={testId} className={cn(CARD, 'flex min-w-0 flex-col gap-[10px] p-3')}>
      <p className={cn('break-words text-[13px]', strong ? 'font-bold' : 'font-semibold')}>
        {title}
      </p>
      <dl className="grid grid-cols-2 gap-2">{children}</dl>
    </li>
  );
}

/** One number as the theme's token tile: a muted caption over a mono value. */
function CardValue({
  metric,
  value,
  costKnown,
}: {
  metric: UsageMetric;
  value: number;
  costKnown?: boolean | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-[10px] py-[9px]">
      <dt className="text-[10.5px] text-[var(--muted)]">{USAGE_METRIC_LABEL[metric]}</dt>
      <dd
        className="mt-[3px] break-all font-machine text-[13px] font-medium tabular-nums"
        data-testid={`usage-card-${metric}`}
        data-value={String(value)}
      >
        {formatUsageValue(metric, value, costKnown)}
      </dd>
    </div>
  );
}
