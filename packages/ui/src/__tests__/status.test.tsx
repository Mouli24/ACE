import { NODE_STATES, PROVIDER_STATES } from '@ace/contracts';
import { render, screen } from '@testing-library/react';

import {
  NODE_STATE_META,
  PROVIDER_STATE_LABEL,
  ProviderStatusChip,
  StatusChip,
  StatusRing,
  StreamingText,
} from '../index.js';

describe('TC-EXE-008 every node state has a distinct visual', () => {
  it('gives each of the nine states its own label, glyph and colour', () => {
    const labels = NODE_STATES.map((state) => NODE_STATE_META[state].label);
    const colours = NODE_STATES.map((state) => NODE_STATE_META[state].color);
    const icons = NODE_STATES.map((state) => NODE_STATE_META[state].glyph);
    expect(new Set(labels).size).toBe(NODE_STATES.length);
    expect(new Set(colours).size).toBe(NODE_STATES.length);
    expect(new Set(icons).size).toBe(NODE_STATES.length);
  });

  it.each(NODE_STATES)('renders %s with its state name readable to assistive tech', (state) => {
    render(<StatusRing state={state} />);
    const ring = screen.getByTestId('status-ring');
    expect(ring).toHaveAttribute('data-state', state);
    expect(ring).toHaveAccessibleName(NODE_STATE_META[state].label);
  });

  it('shows the label as text when asked, as the theme chip (colour on itself at 12%)', () => {
    render(<StatusRing state="RUNNING" showLabel />);
    expect(screen.getByText('running')).toBeInTheDocument();
    const ring = screen.getByTestId('status-ring');
    expect(ring.style.color).toBe('var(--color-status-RUNNING)');
    expect(ring.getAttribute('style') ?? '').toContain(
      'color-mix(in srgb, var(--color-status-RUNNING) 12%, transparent)',
    );
  });

  it('bare, it shows the state glyph in the state colour', () => {
    render(<StatusRing state="FAILED" />);
    expect(screen.getByTestId('status-ring')).toHaveTextContent(NODE_STATE_META.FAILED.glyph);
  });
});

describe('FR-PRV-004 provider status chip', () => {
  it.each(PROVIDER_STATES)('renders %s with its own colour and label', (status) => {
    render(<ProviderStatusChip name="Mock" status={status} />);
    const chip = screen.getByTestId('provider-chip-Mock');
    expect(chip).toHaveAttribute('data-status', status);
    expect(chip).toHaveTextContent(PROVIDER_STATE_LABEL[status]);
    // the dot follows the theme through its variable, light or dark (D328)
    expect(chip.querySelector('[aria-hidden]')?.getAttribute('style')).toContain(
      `var(--color-provider-status-${status})`,
    );
  });

  it('puts the status message and the last check in the title, never a key', () => {
    render(
      <ProviderStatusChip
        name="OpenAI"
        status="AUTH_FAILED"
        message="The API key was rejected."
        lastCheckedAt="2026-09-23T10:00:00.000Z"
      />,
    );
    const chip = screen.getByTestId('provider-chip-OpenAI');
    expect(chip.title).toContain('The API key was rejected.');
    expect(chip.title).toContain('2026-09-23');
  });
});

describe('FR-EXE-008 streaming text', () => {
  it('renders the text it is given in machine type', () => {
    render(<StreamingText text="hello world" nodeRunId="nr_1" />);
    const stream = screen.getByTestId('stream-nr_1');
    expect(stream).toHaveTextContent('hello world');
    expect(stream.className).toContain('font-machine');
  });

  it('marks itself live so a reader announces new text (NFR-USE-02)', () => {
    render(<StreamingText text="a" nodeRunId="nr_1" />);
    expect(screen.getByTestId('stream-nr_1')).toHaveAttribute('aria-live', 'polite');
  });

  it('renders nothing when there is no text yet', () => {
    render(<StreamingText text="" nodeRunId="nr_1" />);
    expect(screen.queryByTestId('stream-nr_1')).not.toBeInTheDocument();
  });

  it('TC-NFR-003 paints an arriving delta within 200 ms', () => {
    const { rerender } = render(<StreamingText text="one" nodeRunId="nr_1" />);
    const started = performance.now();
    rerender(<StreamingText text="one two" nodeRunId="nr_1" />);
    const painted = performance.now() - started;
    expect(screen.getByTestId('stream-nr_1')).toHaveTextContent('one two');
    expect(painted).toBeLessThan(200);
  });
});

describe('FR-EXE-009 StatusChip', () => {
  it.each(NODE_STATES)('%s shows its word beside a dot in its colour', (state) => {
    render(<StatusChip state={state} />);
    const chip = screen.getByTestId('status-chip');
    expect(chip).toHaveAttribute('data-state', state);
    expect(chip).toHaveTextContent(NODE_STATE_META[state].label);
    // the dot is `bg-current`, so the chip's colour is the dot's
    expect(chip.style.color).toBe(`var(--color-status-${state})`);
    // the live states pulse, as the theme's "Working" dot does; nothing else moves
    const live = state === 'RUNNING' || state === 'WAITING';
    expect(chip.querySelector('[data-live="true"]') !== null).toBe(live);
  });
});
