import type { ServerFrame } from '@ace/contracts';
import { ReactFlowProvider, Position } from '@xyflow/react';
import { render, screen } from '@testing-library/react';

import { useRunStore } from '../runs/run-store';
import { TypedEdge, type AceFlowEdge, type FlowEdgeData } from './TypedEdge';

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

function renderEdge(data: FlowEdgeData = props.data as FlowEdgeData, selected = false) {
  return render(
    <ReactFlowProvider>
      <svg>
        <TypedEdge {...props} data={data} selected={selected} />
      </svg>
    </ReactFlowProvider>,
  );
}

/** The visible stroke: BaseEdge's path, not its wide transparent interaction path. */
const stroke = () =>
  (screen.getByTestId('edge-e1').querySelector('path.react-flow__edge-path') as SVGPathElement)
    .style.stroke;

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

describe('TypedEdge (FR-CON-006)', () => {
  it('labels the edge with its data type and offers "no data yet" on hover', () => {
    renderEdge();
    const label = screen.getByTestId('edge-label-e1');
    expect(label).toHaveTextContent('json');
    expect(screen.getByText('no data yet', { selector: 'title' })).toBeInTheDocument();
  });

  it('the label is bare text on a canvas-coloured halo, with no pill behind it', () => {
    renderEdge();
    const label = screen.getByTestId('edge-label-e1');
    expect(label.querySelector('rect')).toBeNull();
    const text = label.querySelector('text');
    expect(text?.textContent).toBe('json');
    expect(text?.style.paintOrder).toBe('stroke');
    expect(text?.style.stroke).toBe('var(--color-canvas)');
  });

  it('an untouched edge is drawn in border-strong, with an arrowhead in the same colour', () => {
    renderEdge({ dataType: 'json', kind: 'data', accent: 'openai' });
    expect(stroke()).toBe('var(--color-border-strong)');
    expect(screen.getByTestId('edge-arrow-e1')).toHaveAttribute(
      'fill',
      'var(--color-border-strong)',
    );
  });

  it('FR-EXE-015 a transferred edge takes the provider colour of its accent', () => {
    transferOnE1();
    renderEdge({ dataType: 'json', kind: 'data', accent: 'openai' });
    expect(screen.getByTestId('edge-e1')).toHaveAttribute('data-transferred', 'true');
    expect(stroke()).toBe('var(--color-provider-openai)');
    expect(screen.getByTestId('edge-arrow-e1')).toHaveAttribute(
      'fill',
      'var(--color-provider-openai)',
    );
  });

  it('FR-EXE-015 an edge with no provider on either end animates in the RUNNING colour', () => {
    transferOnE1();
    renderEdge({ dataType: 'text', kind: 'data' });
    expect(screen.getByTestId('edge-e1')).toHaveAttribute('data-animating', 'true');
    expect(stroke()).toBe('var(--color-status-RUNNING)');
  });

  it('FR-CAN-003 a selected edge is drawn in the selection colour', () => {
    transferOnE1();
    renderEdge({ dataType: 'json', kind: 'data', accent: 'openai' }, true);
    expect(stroke()).toBe('var(--color-selection)');
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
