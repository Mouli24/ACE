import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as XYFlow from '@xyflow/react';

import { CanvasToolbar, type CanvasToolbarProps } from './CanvasToolbar';

const flow = vi.hoisted(() => ({ viewport: { x: 0, y: 0, zoom: 0.75 } }));

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof XYFlow>()),
  useViewport: () => flow.viewport,
}));

function toolbar(props: Partial<CanvasToolbarProps> = {}) {
  const handlers = {
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onResetZoom: vi.fn(),
    onFit: vi.fn(),
    onToggleLock: vi.fn(),
    onToggleHand: vi.fn(),
    onUndoMove: vi.fn(),
  };
  render(
    <CanvasToolbar locked={false} hand={false} canUndoMove={false} {...handlers} {...props} />,
  );
  return handlers;
}

beforeEach(() => {
  flow.viewport = { x: 0, y: 0, zoom: 0.75 };
});

describe('D332 the theme toolbar', () => {
  it('reads the zoom as a whole percentage, in the machine font', () => {
    flow.viewport = { x: 0, y: 0, zoom: 1.2345 };
    toolbar();
    const pct = screen.getByTestId('canvas-zoom-level');
    expect(pct).toHaveTextContent('123%');
    expect(pct).toHaveClass('font-machine', 'text-[10px]', 'min-w-[44px]');
  });

  it('each button does its one thing', async () => {
    const on = toolbar();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset to 100%' }));
    await userEvent.click(screen.getByRole('button', { name: 'Fit to view' }));
    await userEvent.click(screen.getByRole('button', { name: 'Lock nodes' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hand tool' }));
    await userEvent.click(screen.getByRole('button', { name: 'Undo move' }));
    for (const handler of Object.values(on)) expect(handler).toHaveBeenCalledTimes(1);
  });

  it('wears the theme’s glyphs and titles', () => {
    toolbar();
    const glyphs = [
      ['Zoom in', '+'],
      ['Zoom out', '−'],
      ['Fit to screen', '⛶'],
      ['Lock nodes', '🔓︎'],
      ['Hand tool', '✋'],
      ['Undo move', '↶'],
    ] as const;
    for (const [title, glyph] of glyphs) {
      expect(screen.getByTitle(title)).toHaveTextContent(glyph);
    }
  });

  it('lock: 🔒︎ in #ef6b3f on --hover; hand: a white glyph on #ef6b3f', () => {
    toolbar({ locked: true, hand: true });
    const lock = screen.getByRole('button', { name: 'Lock nodes' });
    expect(lock).toHaveTextContent('🔒︎');
    expect(lock).toHaveAttribute('aria-pressed', 'true');
    expect(lock.style.background).toBe('var(--hover)');
    expect(lock.style.color).toBe('rgb(239, 107, 63)');
    const hand = screen.getByRole('button', { name: 'Hand tool' });
    expect(hand).toHaveAttribute('aria-pressed', 'true');
    expect(hand.style.background).toBe('rgb(239, 107, 63)');
    expect(hand.style.color).toBe('rgb(255, 255, 255)');
  });

  it('undo-move is drawn in --iconLine while there is nothing to undo', () => {
    toolbar({ canUndoMove: false });
    expect(screen.getByRole('button', { name: 'Undo move' }).style.color).toBe('var(--iconLine)');
  });

  it('FR-MOB-003 read-only keeps the view controls and drops lock and undo-move', () => {
    toolbar({ readOnly: true });
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fit to view' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lock nodes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo move' })).toBeNull();
  });
});
