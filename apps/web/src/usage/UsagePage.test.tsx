import type { UsageGroupBy, UsageResponse } from '@ace/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { api } from '../app/api';
import { seedUsage } from '../mocks/seeds-round5';
import { db, installMockServer, renderApp } from '../test/app';
import { formatUsageValue, type UsageMetric } from './format';
import { usageRange } from './range';

installMockServer();

const METRICS: UsageMetric[] = ['tokensIn', 'tokensOut', 'costUsd', 'runs'];

/** Every cell of the table against the API's own answer for the same range and grouping. */
async function expectTableEqualsApi(
  groupBy: UsageGroupBy[],
  range: { from: string; to?: string },
): Promise<UsageResponse> {
  const expected = await api().getUsage({ ...range, groupBy });
  expect(expected.buckets.length).toBeGreaterThan(0);
  await waitFor(() =>
    expect(screen.getAllByTestId(/^usage-row-/)).toHaveLength(expected.buckets.length),
  );
  const table = screen.getByTestId('usage-table');
  const headers = within(table)
    .getAllByRole('columnheader')
    .map((th) => th.textContent);
  expect(headers.slice(0, groupBy.length)).toEqual(
    groupBy.map((by) => by[0]!.toUpperCase() + by.slice(1)),
  );

  expected.buckets.forEach((bucket, i) => {
    const row = screen.getByTestId(`usage-row-${i}`);
    const keys = within(row).getAllByTestId(/^usage-key-/);
    expect(keys.map((cell) => cell.getAttribute('data-key'))).toEqual(
      groupBy.map((by) => bucket.key[by]),
    );
    for (const metric of METRICS) {
      const cell = within(row).getByTestId(`usage-${metric}`);
      expect(Number(cell.getAttribute('data-value'))).toBe(bucket[metric]);
      expect(cell).toHaveTextContent(formatUsageValue(metric, bucket[metric]));
    }
  });
  const totals = screen.getByTestId('usage-totals');
  for (const metric of ['tokensIn', 'tokensOut', 'costUsd'] as const) {
    const cell = within(totals).getByTestId(`usage-${metric}`);
    expect(Number(cell.getAttribute('data-value'))).toBe(expected.totals[metric]);
    expect(cell).toHaveTextContent(formatUsageValue(metric, expected.totals[metric]));
  }
  return expected;
}

describe('TC-OBS-004 usage screen equals GET /usage', () => {
  it('shows 7 days by provider by default, cell for cell, with provider names resolved', async () => {
    const seeded = seedUsage(db, 10);
    renderApp('/usage');
    expect(await screen.findByRole('heading', { name: 'Usage' })).toBeInTheDocument();
    expect(screen.getByTestId('usage-preset-7d')).toHaveAttribute('aria-pressed', 'true');

    await expectTableEqualsApi(['provider'], usageRange('7d', { from: '', to: '' })!);
    const names = screen.getAllByTestId('usage-key-provider').map((cell) => cell.textContent);
    expect(names).toEqual(expect.arrayContaining(['Anthropic']));
    expect(names.some((n) => seeded.providerIds.includes(n ?? ''))).toBe(false);
    // the chart draws one bar per bucket
    expect(within(screen.getByTestId('usage-chart-panel')).getAllByTestId('bar')).toHaveLength(
      names.length,
    );
  });

  it('regroups by model and day, and by workflow with its name', async () => {
    seedUsage(db, 5);
    const user = userEvent.setup();
    renderApp('/usage');
    await screen.findAllByTestId(/^usage-row-/);
    const range = usageRange('7d', { from: '', to: '' })!;

    await user.click(screen.getByTestId('usage-group-model'));
    await user.click(screen.getByTestId('usage-group-day'));
    await user.click(screen.getByTestId('usage-group-provider'));
    await expectTableEqualsApi(['model', 'day'], range);

    await user.click(screen.getByTestId('usage-group-workflow'));
    await expectTableEqualsApi(['model', 'day', 'workflow'], range);
    await waitFor(() =>
      expect(screen.getAllByTestId('usage-key-workflow')[0]).toHaveTextContent('Daily digest'),
    );
  });

  it('keeps at least one grouping', async () => {
    seedUsage(db, 2);
    renderApp('/usage');
    await screen.findAllByTestId(/^usage-row-/);
    expect(screen.getByTestId('usage-group-provider')).toBeDisabled();
  });

  it('switches range — today, 30 days and a custom range sent as UTC [from, to)', async () => {
    seedUsage(db, 20);
    const user = userEvent.setup();
    renderApp('/usage');
    await screen.findAllByTestId(/^usage-row-/);

    await user.click(screen.getByTestId('usage-preset-today'));
    await expectTableEqualsApi(['provider'], usageRange('today', { from: '', to: '' })!);

    await user.click(screen.getByTestId('usage-preset-30d'));
    const all = await expectTableEqualsApi(['provider'], usageRange('30d', { from: '', to: '' })!);
    expect(all.buckets.reduce((s, b) => s + b.runs, 0)).toBeGreaterThan(20);

    await user.click(screen.getByTestId('usage-preset-custom'));
    const day = (back: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - back);
      return d.toISOString().slice(0, 10);
    };
    fireEvent.change(screen.getByTestId('usage-from'), { target: { value: day(12) } });
    fireEvent.change(screen.getByTestId('usage-to'), { target: { value: day(10) } });
    const range = usageRange('custom', { from: day(12), to: day(10) })!;
    expect(range.from).toBe(`${day(12)}T00:00:00.000Z`);
    expect(range.to).toBe(`${day(9)}T00:00:00.000Z`);
    const custom = await expectTableEqualsApi(['provider'], range);
    expect(custom.buckets.reduce((s, b) => s + b.runs, 0)).toBe(5); // 3 days: mock ×3, cloud ×2

    fireEvent.change(screen.getByTestId('usage-to'), { target: { value: day(14) } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/on or before/);
  });

  it('draws tokens as a stacked in/out chart on request', async () => {
    seedUsage(db, 3);
    const user = userEvent.setup();
    renderApp('/usage');
    await screen.findAllByTestId(/^usage-row-/);
    await user.click(screen.getByTestId('usage-chart-tokens'));
    const panel = screen.getByTestId('usage-chart-panel');
    expect(within(panel).getByRole('heading')).toHaveTextContent('Tokens by provider');
    const series = new Set(
      within(panel)
        .getAllByTestId('bar')
        .map((b) => b.dataset['series']),
    );
    expect(series).toEqual(new Set(['tokensIn', 'tokensOut']));
  });

  it('renders the same numbers as cards for narrow screens', async () => {
    seedUsage(db, 3);
    renderApp('/usage');
    await screen.findAllByTestId(/^usage-row-/);
    const expected = await api().getUsage({
      ...usageRange('7d', { from: '', to: '' })!,
      groupBy: ['provider'],
    });
    const totals = screen.getByTestId('usage-card-totals');
    expect(within(totals).getByTestId('usage-card-costUsd')).toHaveAttribute(
      'data-value',
      String(expected.totals.costUsd),
    );
    expect(screen.getAllByTestId(/^usage-card-\d+$/)).toHaveLength(expected.buckets.length);
  });

  it('says so when there is nothing in range', async () => {
    renderApp('/usage');
    expect(await screen.findByTestId('usage-empty')).toBeInTheDocument();
  });
});
