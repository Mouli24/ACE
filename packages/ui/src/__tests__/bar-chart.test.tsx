import { render, screen, within } from '@testing-library/react';

import { BarChart, niceScale } from '../components/bar-chart.js';

const data = [
  { label: 'Planner', values: { input: 1200, output: 300 } },
  { label: 'Researcher with a very long name', values: { input: 800, output: 900 } },
  { label: 'Writer', values: { input: 0, output: 150 } },
];
const series = [
  { key: 'input', label: 'Input tokens' },
  { key: 'output', label: 'Output tokens' },
];

describe('FR-OBS-004 BarChart', () => {
  it('is one labelled image with a bar per category and series, each with a tooltip title', () => {
    render(<BarChart data={data} series={series} ariaLabel="Tokens by node" layout="vertical" />);
    const svg = screen.getByRole('img', { name: 'Tokens by node' });
    const bars = svg.querySelectorAll('[data-testid="bar"]');
    expect(bars).toHaveLength(6);
    const first = bars[0];
    expect(first?.getAttribute('data-series')).toBe('input');
    expect(first?.querySelector('title')?.textContent).toBe('Planner — Input tokens: 1,200');
    expect(svg.getAttribute('data-layout')).toBe('vertical');
  });

  it('carries every value in a visually-hidden table for screen readers', () => {
    render(<BarChart data={data} series={series} ariaLabel="Tokens by node" stacked />);
    const table = screen.getByRole('table');
    expect(table).toHaveClass('sr-only');
    expect(within(table).getByRole('columnheader', { name: 'Total' })).toBeInTheDocument();
    const row = within(table).getByRole('row', { name: /Researcher/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual(['800', '900', '1,700']);
  });

  it('stacks segments on one baseline per category when stacked', () => {
    render(<BarChart data={data} series={series} ariaLabel="Stacked" stacked layout="vertical" />);
    const planner = screen
      .getAllByTestId('bar')
      .filter((b) => b.getAttribute('data-label') === 'Planner');
    // Same x for both segments; the output segment sits above the input one.
    expect(planner[0]?.getAttribute('x')).toBe(planner[1]?.getAttribute('x'));
    expect(Number(planner[1]?.getAttribute('y'))).toBeLessThan(
      Number(planner[0]?.getAttribute('y')),
    );
  });

  it('lays out horizontally, truncating long labels with the full label in a title', () => {
    render(<BarChart data={data} series={series} ariaLabel="Narrow" layout="horizontal" />);
    const svg = screen.getByRole('img', { name: 'Narrow' });
    expect(svg.getAttribute('data-layout')).toBe('horizontal');
    const labels = Array.from(svg.querySelectorAll('text')).map((t) => t.textContent ?? '');
    expect(labels.some((l) => l.includes('…'))).toBe(true);
    expect(svg.querySelector('text title')?.textContent).toBeTruthy();
  });

  it('stacked horizontal bars start where the previous segment ended', () => {
    render(<BarChart data={data} series={series} ariaLabel="SH" stacked layout="horizontal" />);
    const planner = screen
      .getAllByTestId('bar')
      .filter((b) => b.getAttribute('data-label') === 'Planner');
    expect(Number(planner[1]?.getAttribute('x'))).toBeGreaterThan(
      Number(planner[0]?.getAttribute('x')),
    );
  });

  it('auto layout goes horizontal when the container is under 480 px (NFR-USE-03)', () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 360 } as DOMRect);
    try {
      render(<BarChart data={data} series={series} ariaLabel="Phone" />);
      expect(screen.getByRole('img', { name: 'Phone' }).getAttribute('data-layout')).toBe(
        'horizontal',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('shows a legend for two or more series, none for one, and themed palette colours by default', () => {
    const { rerender } = render(<BarChart data={data} series={series} ariaLabel="L" />);
    const legend = screen.getByTestId('bar-chart-legend');
    expect(within(legend).getByText('Output tokens')).toBeInTheDocument();
    expect(screen.getAllByTestId('bar')[0]?.getAttribute('fill')).toBe('var(--color-chart-1)');

    rerender(
      <BarChart
        data={data}
        series={[{ key: 'input', label: 'Input', color: '#123456' }]}
        ariaLabel="L"
        format={(n) => `$${n}`}
      />,
    );
    expect(screen.queryByTestId('bar-chart-legend')).toBeNull();
    const bar = screen.getAllByTestId('bar')[0];
    expect(bar?.getAttribute('fill')).toBe('#123456');
    expect(bar?.querySelector('title')?.textContent).toBe('Planner — Input: $1200');
  });

  it('says "No data" for an empty dataset, still as a labelled image', () => {
    render(<BarChart data={[]} series={series} ariaLabel="Empty" />);
    expect(screen.getByRole('img', { name: 'Empty' })).toHaveTextContent('No data');
  });

  it('draws negative values at zero', () => {
    render(
      <BarChart
        data={[{ label: 'x', values: { input: -5 } }]}
        series={[{ key: 'input', label: 'Input' }]}
        ariaLabel="Neg"
        layout="vertical"
      />,
    );
    expect(screen.getByTestId('bar').getAttribute('height')).toBe('0');
  });
});

describe('niceScale', () => {
  it('rounds the axis up to round ticks from zero', () => {
    expect(niceScale(1700)).toEqual({ max: 2000, ticks: [0, 500, 1000, 1500, 2000] });
    expect(niceScale(0.03).max).toBeCloseTo(0.03);
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });
});
