import { ReactFlowProvider, Position } from '@xyflow/react';
import { render, screen } from '@testing-library/react';

import { TypedEdge, type AceFlowEdge } from './TypedEdge';

const props = {
  id: 'e1',
  source: 'a',
  target: 'b',
  sourceX: 0,
  sourceY: 0,
  targetX: 200,
  targetY: 100,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  data: { dataType: 'json' as const, kind: 'data' as const },
  selected: false,
} as unknown as Parameters<typeof TypedEdge>[0];

describe('TypedEdge (FR-CON-006)', () => {
  it('labels the edge with its data type and offers "no data yet" on hover', () => {
    render(
      <ReactFlowProvider>
        <svg>
          <TypedEdge {...props} />
        </svg>
      </ReactFlowProvider>,
    );
    const label = screen.getByTestId('edge-label-e1');
    expect(label).toHaveTextContent('json');
    expect(screen.getByText('no data yet', { selector: 'title' })).toBeInTheDocument();
  });

  it('carries its data through the AceFlowEdge type', () => {
    const edge: AceFlowEdge = {
      id: 'e1',
      source: 'a',
      target: 'b',
      type: 'typed',
      data: { dataType: 'text', kind: 'data' },
    };
    expect(edge.data?.dataType).toBe('text');
  });
});
