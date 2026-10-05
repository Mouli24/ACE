import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as XYFlow from '@xyflow/react';

import { CanvasZoomPill } from './CanvasZoomPill';

const flow = vi.hoisted(() => ({
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  fitView: vi.fn(),
  viewport: { x: 0, y: 0, zoom: 0.75 },
}));

vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof XYFlow>()),
  useReactFlow: () => ({ zoomIn: flow.zoomIn, zoomOut: flow.zoomOut, fitView: flow.fitView }),
  useViewport: () => flow.viewport,
}));

beforeEach(() => {
  flow.zoomIn.mockReset();
  flow.zoomOut.mockReset();
  flow.fitView.mockReset();
  flow.viewport = { x: 0, y: 0, zoom: 0.75 };
});

describe('FR-CAN-001 the zoom pill', () => {
  it('reads the viewport zoom as a whole percentage', () => {
    flow.viewport = { x: 0, y: 0, zoom: 1.2345 };
    render(<CanvasZoomPill />);
    expect(screen.getByTestId('canvas-zoom-level')).toHaveTextContent('123%');
  });

  it('− zooms out, + zooms in and Fit fits the graph', async () => {
    render(<CanvasZoomPill />);
    expect(screen.getByTestId('canvas-zoom-level')).toHaveTextContent('75%');

    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(flow.zoomOut).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(flow.zoomIn).toHaveBeenCalledTimes(1);

    // the Canvas's one Fit control: visible "Fit", named "Fit to view"
    const fit = screen.getByRole('button', { name: 'Fit to view' });
    expect(fit).toHaveTextContent(/^Fit$/);
    expect(fit).toHaveAttribute('title', 'Fit to view (F)');
    await userEvent.click(fit);
    expect(flow.fitView).toHaveBeenCalledWith(expect.objectContaining({ padding: 0.2 }));
  });

  it('is a pill of round machine-font buttons', () => {
    render(<CanvasZoomPill />);
    expect(screen.getByTestId('canvas-zoom-pill')).toHaveClass(
      'rounded-chip',
      'border-border',
      'bg-panel',
    );
    for (const name of ['Zoom out', 'Zoom in', 'Fit to view']) {
      expect(screen.getByRole('button', { name })).toHaveClass('rounded-chip', 'font-machine');
    }
  });
});
