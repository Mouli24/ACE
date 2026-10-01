import { useEffect, useRef, useState, type RefObject } from 'react';

import { cn } from '../lib/cn.js';
import { chartSeriesColor } from '../tokens.js';

/**
 * A bar chart for usage and cost breakdowns (FR-OBS-004). Hand-rolled SVG, no chart library.
 *
 * - Sized in real pixels from its container (ResizeObserver), so text never scales down with the
 *   viewBox; at narrow widths (or with many categories) it lays the bars out horizontally, one row
 *   per category, which is what stays readable at 380 px (NFR-USE-03).
 * - Colours come from CSS variables (`--color-chart-N`, `--color-fg-muted`, `--color-border`), so
 *   it follows the active theme; text uses text tokens, never the series colour.
 * - Accessible: the SVG is `role="img"` with the caller's label, every bar has a `<title>` (the
 *   native hover tooltip), and a visually-hidden table carries every value for screen readers.
 * - Values below zero are drawn at zero (usage and cost are never negative); the table keeps them.
 */

export interface BarChartSeries {
  key: string;
  label: string;
  /** A CSS colour; defaults to the series' slot in the chart palette. */
  color?: string;
}

export interface BarChartDatum {
  label: string;
  values: Record<string, number>;
}

export interface BarChartProps {
  data: readonly BarChartDatum[];
  series: readonly BarChartSeries[];
  ariaLabel: string;
  format?: (n: number) => string;
  /** Stack the series in one bar per category instead of grouping them side by side. */
  stacked?: boolean;
  /** `auto` (default) switches to horizontal bars when the container is narrow. */
  layout?: 'auto' | 'vertical' | 'horizontal';
  /** Plot height for the vertical layout, px. */
  height?: number;
  className?: string;
}

const defaultFormat = (n: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);

/** A 0-based axis with 4–5 round ticks covering `max`. */
export function niceScale(max: number, count = 4): { max: number; ticks: number[] } {
  if (!(max > 0) || !Number.isFinite(max)) return { max: 1, ticks: [0, 1] };
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * magnitude >= raw) ?? 10) * magnitude;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let i = 0; i <= Math.round(top / step); i += 1)
    ticks.push(Number((i * step).toPrecision(12)));
  return { max: top, ticks };
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return maxChars <= 1 ? '…' : `${text.slice(0, maxChars - 1)}…`;
}

const NARROW_PX = 480;
const MIN_BAND_PX = 56;
const CHAR_PX = 6.5;
const GAP = 2;

function useWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setWidth(Math.round(w));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

interface Bar {
  key: string;
  seriesKey: string;
  datumLabel: string;
  value: number;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function BarChart({
  data,
  series,
  ariaLabel,
  format = defaultFormat,
  stacked = false,
  layout = 'auto',
  height = 200,
  className,
}: BarChartProps) {
  const [ref, width] = useWidth();
  const colorOf = (i: number): string => series[i]?.color ?? chartSeriesColor(i);
  const valueOf = (d: BarChartDatum, key: string): number => Math.max(0, d.values[key] ?? 0);

  const totals = data.map((d) => series.reduce((sum, s) => sum + valueOf(d, s.key), 0));
  const peak = stacked
    ? Math.max(0, ...totals)
    : Math.max(0, ...data.flatMap((d) => series.map((s) => valueOf(d, s.key))));
  const scale = niceScale(peak);

  const horizontal =
    layout === 'horizontal' ||
    (layout === 'auto' && (width < NARROW_PX || width / Math.max(1, data.length) < MIN_BAND_PX));

  const bars: Bar[] = [];
  let svgHeight: number;
  let grid: { pos: number; label: string }[];
  let categoryLabels: {
    x: number;
    y: number;
    text: string;
    full: string;
    anchor: 'end' | 'middle';
  }[];
  let plot: { x0: number; y0: number; x1: number; y1: number };

  if (horizontal) {
    const labelW = Math.min(112, Math.max(64, Math.round(width * 0.28)));
    const rowH = stacked || series.length === 1 ? 28 : series.length * 12 + 12;
    const top = 4;
    const axisH = 20;
    const x0 = labelW + 8;
    const x1 = Math.max(x0 + 40, width - 12);
    const span = x1 - x0;
    svgHeight = top + data.length * rowH + axisH;
    plot = { x0, y0: top, x1, y1: top + data.length * rowH };
    grid = scale.ticks.map((t) => ({ pos: x0 + (t / scale.max) * span, label: format(t) }));
    categoryLabels = data.map((d, i) => ({
      x: labelW,
      y: top + i * rowH + rowH / 2 + 4,
      text: truncate(d.label, Math.floor(labelW / CHAR_PX)),
      full: d.label,
      anchor: 'end',
    }));
    data.forEach((d, i) => {
      const rowTop = top + i * rowH + 6;
      const inner = rowH - 12;
      let cursor = x0;
      series.forEach((s, si) => {
        const value = valueOf(d, s.key);
        const w = (value / scale.max) * span;
        if (stacked) {
          bars.push({
            key: `${i}-${s.key}`,
            seriesKey: s.key,
            datumLabel: d.label,
            value,
            color: colorOf(si),
            x: cursor,
            y: rowTop,
            w: Math.max(0, w - (w > GAP ? GAP : 0)),
            h: inner,
          });
          cursor += w;
        } else {
          const bh = inner / series.length;
          bars.push({
            key: `${i}-${s.key}`,
            seriesKey: s.key,
            datumLabel: d.label,
            value,
            color: colorOf(si),
            x: x0,
            y: rowTop + si * bh,
            w,
            h: Math.max(1, bh - GAP),
          });
        }
      });
    });
  } else {
    const left = 48;
    const right = 8;
    const top = 8;
    const bottom = 24;
    const x0 = left;
    const x1 = Math.max(x0 + 40, width - right);
    const y1 = top + height;
    svgHeight = y1 + bottom;
    plot = { x0, y0: top, x1, y1 };
    const band = (x1 - x0) / Math.max(1, data.length);
    const inner = band * 0.7;
    grid = scale.ticks.map((t) => ({ pos: y1 - (t / scale.max) * height, label: format(t) }));
    categoryLabels = data.map((d, i) => ({
      x: x0 + band * i + band / 2,
      y: y1 + 16,
      text: truncate(d.label, Math.max(2, Math.floor(band / CHAR_PX))),
      full: d.label,
      anchor: 'middle',
    }));
    data.forEach((d, i) => {
      const bandLeft = x0 + band * i + (band - inner) / 2;
      let base = y1;
      series.forEach((s, si) => {
        const value = valueOf(d, s.key);
        const h = (value / scale.max) * height;
        if (stacked) {
          const drawn = Math.max(0, h - (h > GAP ? GAP : 0));
          bars.push({
            key: `${i}-${s.key}`,
            seriesKey: s.key,
            datumLabel: d.label,
            value,
            color: colorOf(si),
            x: bandLeft,
            y: base - h,
            w: inner,
            h: drawn,
          });
          base -= h;
        } else {
          const bw = inner / series.length;
          bars.push({
            key: `${i}-${s.key}`,
            seriesKey: s.key,
            datumLabel: d.label,
            value,
            color: colorOf(si),
            x: bandLeft + si * bw,
            y: y1 - h,
            w: Math.max(1, bw - GAP),
            h,
          });
        }
      });
    });
  }

  const seriesLabel = (key: string): string => series.find((s) => s.key === key)?.label ?? key;

  return (
    <figure className={cn('m-0 flex w-full flex-col gap-2', className)} data-testid="bar-chart">
      {series.length >= 2 ? (
        <ul
          className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-muted"
          data-testid="bar-chart-legend"
        >
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-sm"
                style={{ background: colorOf(i) }}
              />
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div ref={ref} className="w-full">
        {data.length === 0 ? (
          <div
            role="img"
            aria-label={ariaLabel}
            className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-fg-muted"
          >
            No data
          </div>
        ) : (
          <svg
            role="img"
            aria-label={ariaLabel}
            data-layout={horizontal ? 'horizontal' : 'vertical'}
            viewBox={`0 0 ${width} ${svgHeight}`}
            width="100%"
            height={svgHeight}
            className="block overflow-visible font-machine"
          >
            <g aria-hidden>
              {grid.map((g) =>
                horizontal ? (
                  <g key={g.pos}>
                    <line
                      x1={g.pos}
                      x2={g.pos}
                      y1={plot.y0}
                      y2={plot.y1}
                      stroke="var(--color-border)"
                      strokeWidth={1}
                    />
                    <text
                      x={g.pos}
                      y={plot.y1 + 14}
                      textAnchor="middle"
                      fontSize={10}
                      fill="var(--color-fg-muted)"
                    >
                      {g.label}
                    </text>
                  </g>
                ) : (
                  <g key={g.pos}>
                    <line
                      x1={plot.x0}
                      x2={plot.x1}
                      y1={g.pos}
                      y2={g.pos}
                      stroke="var(--color-border)"
                      strokeWidth={1}
                    />
                    <text
                      x={plot.x0 - 6}
                      y={g.pos + 3}
                      textAnchor="end"
                      fontSize={10}
                      fill="var(--color-fg-muted)"
                    >
                      {g.label}
                    </text>
                  </g>
                ),
              )}
              {categoryLabels.map((c, i) => (
                <text
                  key={i}
                  x={c.x}
                  y={c.y}
                  textAnchor={c.anchor}
                  fontSize={11}
                  fill="var(--color-fg-muted)"
                >
                  <title>{c.full}</title>
                  {c.text}
                </text>
              ))}
            </g>
            {bars.map((b) => (
              <rect
                key={b.key}
                data-testid="bar"
                data-series={b.seriesKey}
                data-label={b.datumLabel}
                x={b.x}
                y={b.y}
                width={b.w}
                height={b.h}
                rx={2}
                fill={b.color}
              >
                <title>{`${b.datumLabel} — ${seriesLabel(b.seriesKey)}: ${format(b.value)}`}</title>
              </rect>
            ))}
          </svg>
        )}
      </div>
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
            {stacked && series.length > 1 ? <th scope="col">Total</th> : null}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={`${d.label}-${i}`}>
              <th scope="row">{d.label}</th>
              {series.map((s) => (
                <td key={s.key}>{format(d.values[s.key] ?? 0)}</td>
              ))}
              {stacked && series.length > 1 ? <td>{format(totals[i] ?? 0)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
