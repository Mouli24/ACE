import type { LoopConfig } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import { Position, ReactFlowProvider } from '@xyflow/react';

import { EdgeChip } from '../../canvas/EdgeLayer';
import { LOOP_EDGE_TYPE, LoopEdge, loopEdgeType, type LoopFlowEdgeData } from './LoopEdge';

const loop: LoopConfig = {
  maxIterations: 5,
  exitCondition: { path: 'verdict', equals: 'approved' },
  onMax: 'continue',
};

function renderEdge(data: LoopFlowEdgeData) {
  const props = {
    id: 'l1',
    source: 'reviewer',
    target: 'writer',
    sourceX: 200,
    sourceY: 100,
    targetX: 0,
    targetY: 0,
    sourcePosition: Position.Left,
    targetPosition: Position.Right,
    data,
    selected: false,
  } as unknown as Parameters<typeof LoopEdge>[0];
  return render(
    <ReactFlowProvider>
      <svg>
        <LoopEdge {...props} />
      </svg>
    </ReactFlowProvider>,
  );
}

describe('LoopEdge: React Flow’s invisible hit band (FR-CON-007, D332)', () => {
  it('is a transparent band that says it is the loop, with no iteration outside a run', () => {
    renderEdge({ kind: 'loop', loop });
    const edge = screen.getByTestId('loop-edge-l1');
    expect(edge).toHaveAttribute('data-kind', 'loop');
    expect(edge).toHaveAttribute('data-iteration', 'none');
    expect(edge).toHaveAttribute('data-running', 'false');
    expect((edge.querySelector('path') as SVGPathElement).style.stroke).toBe('transparent');
  });

  it('says on hover how far the loop goes and how it ends', () => {
    renderEdge({ kind: 'loop', loop });
    expect(
      screen.getByText(
        'Loops at most 5× · exits when verdict = approved · at the maximum: continue',
        { selector: 'title' },
      ),
    ).toBeInTheDocument();
  });

  it('carries the iteration and liveness the run reports (FR-PAR-005)', () => {
    renderEdge({ kind: 'loop', loop, iteration: 2, running: true });
    const edge = screen.getByTestId('loop-edge-l1');
    expect(edge).toHaveAttribute('data-iteration', '2');
    expect(edge).toHaveAttribute('data-running', 'true');
  });

  it('registers under the edge type the Canvas mounts', () => {
    expect(LOOP_EDGE_TYPE).toBe('loop');
    expect(loopEdgeType.loop).toBe(LoopEdge);
  });
});

describe('the loop edge’s chip (D332)', () => {
  it('reads "↩ loop · max N" with the glyph on its own', () => {
    render(<EdgeChip id="l1" mx={10} my={20} label={{ kind: 'loop', max: 5 }} />);
    const chip = screen.getByTestId('loop-edge-label-l1');
    expect(chip).toHaveTextContent('↩ loop · max 5');
    expect(screen.getByTestId('loop-edge-glyph-l1')).toHaveTextContent('↩');
    expect(screen.queryByTestId('loop-edge-iteration-l1')).toBeNull();
  });

  it('adds "· i/N" once a run has reached the loop', () => {
    render(<EdgeChip id="l1" mx={10} my={20} label={{ kind: 'loop', max: 5, iteration: 2 }} />);
    expect(screen.getByTestId('loop-edge-label-l1')).toHaveTextContent('↩ loop · max 5 · 2/5');
    expect(screen.getByTestId('loop-edge-iteration-l1').textContent).toBe('2/5');
  });
});
