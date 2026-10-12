import type { ServerFrame } from '@ace/contracts';
import { ReactFlowProvider, Position } from '@xyflow/react';
import { render, screen } from '@testing-library/react';

import { edgePath } from '../canvas/viewport';
import { useRunStore } from '../runs/run-store';
import {
  EDGE_HIT_WIDTH,
  TypedEdge,
  interactionPath,
  type AceFlowEdge,
  type FlowEdgeData,
} from './TypedEdge';

const RUN = '01RUN0000000000000000000000';
const WF = '01WF00000000000000000000000';

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

function renderEdge(data: FlowEdgeData = props.data as FlowEdgeData) {
  return render(
    <ReactFlowProvider>
      <svg>
        <TypedEdge {...props} data={data} />
      </svg>
    </ReactFlowProvider>,
  );
}

function transferOnE1() {
  const store = useRunStore.getState();
  store.begin(WF, RUN, 'RUNNING');
  store.apply({
    seq: 1,
    type: 'edge.transfer',
    payload: {
      runId: RUN,
      edgeId: 'e1',
      fromNodeId: 'a',
      toNodeId: 'b',
      iteration: 1,
      summary: 'hi',
    },
  } as ServerFrame);
}

beforeEach(() => useRunStore.getState().reset());

describe('TypedEdge: React Flow’s invisible hit band (D332, FR-CON-006)', () => {
  it('draws nothing visible: a transparent path with a 16px band for clicks', () => {
    renderEdge();
    const group = screen.getByTestId('edge-e1');
    const visible = group.querySelector('path.react-flow__edge-path') as SVGPathElement;
    expect(visible.style.stroke).toBe('transparent');
    const band = group.querySelector('path.react-flow__edge-interaction') as SVGPathElement;
    expect(band).toHaveAttribute('stroke-width', String(EDGE_HIT_WIDTH));
    expect(group).toHaveAttribute('data-datatype', 'json');
  });

  it('follows the theme’s curve between the handles’ centres (6px in from React Flow’s ends)', () => {
    renderEdge();
    const visible = screen
      .getByTestId('edge-e1')
      .querySelector('path.react-flow__edge-path') as SVGPathElement;
    expect(visible.getAttribute('d')).toBe(edgePath(-6, 0, 206, 100).d);
    expect(interactionPath(0, 0, 200, 100)).toBe(edgePath(-6, 0, 206, 100).d);
  });

  it('says "no data yet" on hover until a run crosses it', () => {
    renderEdge();
    expect(screen.getByText('no data yet', { selector: 'title' })).toBeInTheDocument();
    expect(screen.getByTestId('edge-e1')).toHaveAttribute('data-transferred', 'false');
  });

  it('FR-EXE-015 a transfer carries the engine’s summary and marks the edge as just crossed', () => {
    transferOnE1();
    renderEdge();
    const group = screen.getByTestId('edge-e1');
    expect(group).toHaveAttribute('data-transferred', 'true');
    expect(group).toHaveAttribute('data-animating', 'true');
    expect(screen.getByText('hi', { selector: 'title' })).toBeInTheDocument();
  });

  it('carries its data through the AceFlowEdge type', () => {
    const edge: AceFlowEdge = {
      id: 'e1',
      source: 'a',
      target: 'b',
      type: 'typed',
      data: { dataType: 'text', kind: 'data', accent: 'anthropic' },
    };
    expect(edge.data?.dataType).toBe('text');
    expect(edge.data?.accent).toBe('anthropic');
  });
});
