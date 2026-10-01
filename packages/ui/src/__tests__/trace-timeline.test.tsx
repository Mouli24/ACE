import { TRACE_ENTRY_KINDS, type TraceEntry } from '@ace/contracts';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { TRACE_KIND_ICON, TraceTimeline, formatDurationMs } from '../components/trace-timeline.js';

const t0 = '2026-10-02T10:00:00.000Z';
const entries: TraceEntry[] = [
  { seq: 1, at: t0, kind: 'run_event', label: 'Run started', detail: { type: 'run.started' } },
  {
    seq: 2,
    at: '2026-10-02T10:00:01.200Z',
    kind: 'node_run',
    nodeId: 'node_planner',
    label: 'Planner completed',
    detail: { state: 'COMPLETED', tokens: 42 },
    durationMs: 1200,
  },
  {
    seq: 3,
    at: '2026-10-02T10:00:02.000Z',
    kind: 'tool_call',
    label: 'web_search',
    detail: { query: 'ace' },
    durationMs: 320,
  },
  { seq: 4, at: '2026-10-02T10:00:03.000Z', kind: 'verdict', label: 'pass', detail: undefined },
];

describe('FR-OBS-001 TraceTimeline', () => {
  it('renders entries in the given seq order with a testid and kind each', () => {
    render(<TraceTimeline entries={entries} />);
    const list = screen.getByRole('list', { name: 'Run trace' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-testid'))).toEqual([
      'trace-entry-1',
      'trace-entry-2',
      'trace-entry-3',
      'trace-entry-4',
    ]);
    expect(screen.getByTestId('trace-entry-3')).toHaveAttribute('data-kind', 'tool_call');
  });

  it('shows the time since the start and the duration where the entry spans time', () => {
    render(<TraceTimeline entries={entries} />);
    const planner = screen.getByTestId('trace-entry-2');
    expect(planner).toHaveTextContent('+1.2 s');
    expect(within(planner).getByTestId('trace-duration')).toHaveTextContent('took 1.2 s');
    expect(
      within(screen.getByTestId('trace-entry-3')).getByTestId('trace-duration'),
    ).toHaveTextContent('took 320 ms');
    expect(within(screen.getByTestId('trace-entry-1')).queryByTestId('trace-duration')).toBeNull();
  });

  it('expands the detail from the keyboard, with aria-expanded tracking it', async () => {
    const user = userEvent.setup();
    render(<TraceTimeline entries={entries} />);
    const button = within(screen.getByTestId('trace-entry-2')).getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('"COMPLETED"')).toBeNull();

    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const detail = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(detail).not.toBeNull();
    expect(within(detail as HTMLElement).getByText('"COMPLETED"')).toBeInTheDocument();

    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('an entry without detail has nothing to expand', () => {
    render(<TraceTimeline entries={entries} />);
    const button = within(screen.getByTestId('trace-entry-4')).getByRole('button');
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute('aria-expanded');
  });

  it('honours defaultExpanded and a given start instant', () => {
    render(
      <TraceTimeline
        entries={entries.slice(1, 2)}
        startedAt="2026-10-02T09:58:00.000Z"
        defaultExpanded={[2]}
      />,
    );
    const row = screen.getByTestId('trace-entry-2');
    expect(within(row).getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    expect(row).toHaveTextContent('+2 m 01 s');
  });

  it('has an icon for every trace kind, and an empty state', () => {
    expect(Object.keys(TRACE_KIND_ICON).sort()).toEqual([...TRACE_ENTRY_KINDS].sort());
    render(<TraceTimeline entries={[]} />);
    expect(screen.getByTestId('trace-empty')).toHaveTextContent('No trace entries yet.');
  });

  it('formats durations', () => {
    expect(formatDurationMs(0)).toBe('0 ms');
    expect(formatDurationMs(59_999)).toBe('60.0 s');
    expect(formatDurationMs(125_000)).toBe('2 m 05 s');
  });
});
