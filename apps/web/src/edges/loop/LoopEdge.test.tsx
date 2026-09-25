import type { LoopConfig } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import { Position, ReactFlowProvider } from '@xyflow/react';

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

describe('LoopEdge (FR-CON-007)', () => {
  it('draws the loop style and an arrow-back glyph, with no badge outside a run', () => {
    renderEdge({ kind: 'loop', loop });
    const edge = screen.getByTestId('loop-edge-l1');
    expect(edge.querySelector('path')).toHaveClass('ace-loop-edge');
    expect(edge.querySelector('path')).not.toHaveClass('ace-loop-edge-running');
    expect(screen.getByTestId('loop-edge-glyph-l1')).toHaveTextContent('↩');
    expect(screen.queryByTestId('loop-edge-iteration-l1')).not.toBeInTheDocument();
    expect(edge).toHaveAttribute('data-iteration', 'none');
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

  it('badges the iteration against the maximum while a run is going (FR-PAR-005)', () => {
    renderEdge({ kind: 'loop', loop, iteration: 2, running: true });
    expect(screen.getByTestId('loop-edge-iteration-l1')).toHaveTextContent('2/5');
    const edge = screen.getByTestId('loop-edge-l1');
    expect(edge).toHaveAttribute('data-iteration', '2');
    expect(edge).toHaveAttribute('data-running', 'true');
    expect(edge.querySelector('path')).toHaveClass('ace-loop-edge-running');
  });

  it('keeps the badge but stops the dash once the run is no longer live', () => {
    renderEdge({ kind: 'loop', loop, iteration: 5, running: false });
    expect(screen.getByTestId('loop-edge-iteration-l1')).toHaveTextContent('5/5');
    expect(screen.getByTestId('loop-edge-l1').querySelector('path')).not.toHaveClass(
      'ace-loop-edge-running',
    );
  });

  it('registers under the edge type the Canvas mounts', () => {
    expect(LOOP_EDGE_TYPE).toBe('loop');
    expect(loopEdgeType.loop).toBe(LoopEdge);
  });
});
