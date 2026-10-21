import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { useLayoutStore } from '../../app/stores/layout';
import { renderWithQuery } from '../../test/app';
import { BottomPanel } from '../panel/BottomPanel';
import { EXPLORER_WIDTH, FORGE_SIZES_KEY, PANEL_HEIGHT, useForgeSizes } from './sizes';
import { Splitter } from './Splitter';

afterEach(() => {
  useForgeSizes.setState({
    explorerWidth: EXPLORER_WIDTH.initial,
    panelHeight: PANEL_HEIGHT.initial,
  });
  useLayoutStore.setState({ panelMaximized: false });
});

/** The Explorer's edge, wired to the store as the Explorer wires it. */
function ExplorerEdge() {
  const width = useForgeSizes((s) => s.explorerWidth);
  return (
    <Splitter
      label="Resize the Explorer"
      orientation="vertical"
      grows="forward"
      value={width}
      bounds={EXPLORER_WIDTH}
      onResize={useForgeSizes.getState().setExplorerWidth}
    />
  );
}

describe('[audit F-7] D299 Forge’s panels can be resized', () => {
  it('drags the Explorer’s edge, within its bounds, and remembers the width', () => {
    render(<ExplorerEdge />);
    const edge = screen.getByRole('separator', { name: 'Resize the Explorer' });
    expect(edge).toHaveAttribute('aria-valuenow', '248');

    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: 360 });
    fireEvent.pointerUp(edge, { pointerId: 1, clientX: 360 });
    expect(edge).toHaveAttribute('aria-valuenow', '308');
    expect(localStorage.getItem(FORGE_SIZES_KEY)).toContain('"explorerWidth":308');

    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: 360 });
    fireEvent.pointerMove(edge, { pointerId: 1, clientX: -1000 });
    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(edge).toHaveAttribute('aria-valuenow', String(EXPLORER_WIDTH.min));

    fireEvent.doubleClick(edge);
    expect(edge).toHaveAttribute('aria-valuenow', '248');
  });

  it('resizes from the keyboard: the arrows by 16px, Home and End to the bounds', async () => {
    const user = userEvent.setup();
    render(<ExplorerEdge />);
    const edge = screen.getByRole('separator', { name: 'Resize the Explorer' });
    act(() => edge.focus());
    await user.keyboard('{ArrowRight}');
    expect(edge).toHaveAttribute('aria-valuenow', '264');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(edge).toHaveAttribute('aria-valuenow', '232');
    await user.keyboard('{End}');
    expect(edge).toHaveAttribute('aria-valuenow', String(EXPLORER_WIDTH.max));
    await user.keyboard('{Home}');
    expect(edge).toHaveAttribute('aria-valuenow', String(EXPLORER_WIDTH.min));
  });

  it('the bottom panel grows when its top edge goes up, and has no edge while maximized', async () => {
    const user = userEvent.setup();
    renderWithQuery(<BottomPanel projectId="01J9ZZZZZZZZZZZZZZZZZZZZZZ" />);
    const panel = screen.getByRole('region', { name: 'Panel' });
    expect(panel).toHaveStyle({ height: '232px' });
    const edge = screen.getByRole('separator', { name: 'Resize the panel' });

    fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(edge, { pointerId: 1, clientY: 400 });
    fireEvent.pointerUp(edge, { pointerId: 1 });
    expect(panel).toHaveStyle({ height: '332px' });
    act(() => edge.focus());
    await user.keyboard('{ArrowDown}');
    expect(panel).toHaveStyle({ height: '316px' });

    await user.click(screen.getByRole('button', { name: 'Maximize panel' }));
    expect(screen.queryByRole('separator', { name: 'Resize the panel' })).toBeNull();
  });
});
