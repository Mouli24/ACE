import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '../components/context-menu.js';
import { ProgressBar } from '../components/progress-bar.js';
import { SourceChip, formatScore } from '../components/source-chip.js';

describe('FR-RAG-007 SourceChip', () => {
  it('as a button: shows source, score to two decimals and via, and opens on click', async () => {
    const onOpen = vi.fn();
    render(<SourceChip source="handbook.pdf#3" score={0.8734} via="both" onOpen={onOpen} />);
    const chip = screen.getByRole('button', {
      name: 'Source handbook.pdf#3, score 0.87, via both',
    });
    expect(chip).toHaveTextContent('handbook.pdf#3');
    expect(screen.getByTestId('source-score')).toHaveTextContent('0.87');
    expect(screen.getByTestId('source-via')).toHaveTextContent('both');
    await userEvent.click(chip);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('as a link when given href', () => {
    render(<SourceChip source="notes.md" href="/knowledge/kb_1/documents/doc_1" />);
    const link = screen.getByRole('link', { name: 'Source notes.md' });
    expect(link).toHaveAttribute('href', '/knowledge/kb_1/documents/doc_1');
    expect(screen.queryByTestId('source-score')).toBeNull();
  });

  it('as plain text with neither, and clamps scores to 0..1', () => {
    render(<SourceChip source="a.txt" score={1.7} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('source-chip')).toHaveTextContent('1.00');
    expect(formatScore(-0.2)).toBe('0.00');
    expect(formatScore(Number.NaN)).toBe('0.00');
  });
});

describe('FR-CAN-011 ContextMenu', () => {
  function Menu({ onDuplicate, onDelete }: { onDuplicate: () => void; onDelete: () => void }) {
    return (
      <ContextMenu>
        <ContextMenuTrigger>
          <div data-testid="target">Node</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onDuplicate}>
            Duplicate <ContextMenuShortcut>⌘D</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem destructive onSelect={onDelete}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  it('opens on right-click and runs the chosen item', async () => {
    const onDuplicate = vi.fn();
    const onDelete = vi.fn();
    render(<Menu onDuplicate={onDuplicate} onDelete={onDelete} />);
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.contextMenu(screen.getByTestId('target'));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveClass('bg-[var(--surface)]');
    expect(screen.getByRole('separator')).toBeInTheDocument();
    expect(screen.getByText('⌘D')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass('text-[#c94c27]');

    await userEvent.click(screen.getByRole('menuitem', { name: /Duplicate/ }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape without running anything', async () => {
    const onDuplicate = vi.fn();
    render(<Menu onDuplicate={onDuplicate} onDelete={vi.fn()} />);
    fireEvent.contextMenu(screen.getByTestId('target'));
    await screen.findByRole('menu');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onDuplicate).not.toHaveBeenCalled();
  });
});

describe('ProgressBar', () => {
  it('is a progressbar with min, max, now and a percentage', () => {
    render(<ProgressBar value={30} max={60} label="Ingesting" showValue />);
    const bar = screen.getByRole('progressbar', { name: 'Ingesting' });
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '60');
    expect(bar).toHaveAttribute('aria-valuenow', '30');
    expect(bar).toHaveAttribute('aria-valuetext', '50%');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('clamps out-of-range values and is indeterminate without one', () => {
    const { rerender } = render(<ProgressBar value={250} label="P" tone="danger" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    rerender(<ProgressBar label="P" max={0} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-valuetext', 'In progress');
  });
});
