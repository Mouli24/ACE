import type { Edge, LoopConfig } from '@ace/contracts';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';

import { createNode } from '../nodes/factory';
import { EdgeChip, EdgeLayer, EdgeStroke } from './EdgeLayer';
import { toFlowEdges, toFlowNodes } from './to-flow';
import { edgePath } from './viewport';

const WF = '01WF00000000000000000000000';
/** The layer reads positions only; the cards themselves are not under test here. */
const nodeTypes = { ace: () => <div /> };

describe('EdgeStroke: an edge as the theme draws it (D332)', () => {
  const stroke = (selected: boolean) =>
    render(
      <svg>
        <EdgeStroke
          id="e1"
          d="M0 0 C50 0 50 10 100 10"
          x1={0}
          y1={0}
          x2={100}
          y2={10}
          selected={selected}
        />
      </svg>,
    );

  it('a 6px glow at --edgeGlow, the dashed 1.6px flowing line, a filled start and a ringed end', () => {
    stroke(false);
    const group = screen.getByTestId('edge-line-e1');
    const [glow, line] = Array.from(group.querySelectorAll('path')) as SVGPathElement[];
    expect(glow?.style.strokeWidth).toBe('6');
    expect(glow?.style.opacity).toBe('var(--edgeGlow)');
    expect(line?.style.strokeWidth).toBe('1.6');
    expect(line?.style.strokeDasharray).toBe('5 5');
    expect(line).toHaveClass('ace-edge-flow');
    const [start, end] = Array.from(group.querySelectorAll('circle'));
    expect(start).toHaveAttribute('r', '3');
    expect(end).toHaveAttribute('r', '3.5');
    expect((end as SVGCircleElement).style.fill).toBe('var(--canvas)');
  });

  it('a selected edge raises its glow to 0.3', () => {
    stroke(true);
    const glow = screen.getByTestId('edge-line-e1').querySelector('path') as SVGPathElement;
    expect(glow.style.opacity).toBe('0.3');
  });
});

describe('EdgeChip: the label at the curve’s midpoint', () => {
  it('a data edge shows its source port’s data type, centred on the midpoint', () => {
    render(<EdgeChip id="e1" mx={120} my={40} label={{ kind: 'data', dataType: 'json' }} />);
    const chip = screen.getByTestId('edge-label-e1');
    expect(chip).toHaveTextContent('json');
    expect(chip.style.left).toBe('120px');
    expect(chip.style.top).toBe('40px');
    expect(chip.style.transform).toBe('translate(-50%,-50%)');
    expect(chip).toHaveClass('pointer-events-none', 'bg-[var(--chip)]', 'text-[9.5px]');
  });
});

describe('EdgeLayer: anchors on the live node positions', () => {
  it('draws each edge from the out-anchor to the in-anchor, labelled from the graph', () => {
    const input = createNode('input', WF, { x: 0, y: 0 });
    const agent = createNode('agent', WF, { x: 400, y: 100 });
    const writer = createNode('agent', WF, { x: 800, y: 100 });
    const data: Edge = {
      id: 'e1',
      workflowId: WF,
      kind: 'data',
      from: { nodeId: input.id, portId: input.outputs[0]!.id },
      to: { nodeId: agent.id, portId: agent.inputs[0]!.id },
    };
    const loop: LoopConfig = {
      maxIterations: 3,
      exitCondition: { path: 'ok', equals: true },
      onMax: 'continue',
    };
    const back: Edge = {
      id: 'l1',
      workflowId: WF,
      kind: 'loop',
      from: { nodeId: writer.id, portId: writer.outputs[0]!.id },
      to: { nodeId: agent.id, portId: agent.inputs[0]!.id },
      loop,
    };
    const nodes = [input, agent, writer];
    const edges = toFlowEdges([data, back], nodes, (edge) =>
      edge.kind === 'loop' ? { iteration: 2, running: true } : {},
    );
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow
            nodes={toFlowNodes(nodes, [data, back], undefined, () => undefined)}
            edges={[]}
            nodeTypes={nodeTypes}
          >
            <EdgeLayer nodes={nodes} edges={edges} />
          </ReactFlow>
        </div>
      </ReactFlowProvider>,
    );

    expect(screen.getByTestId('edge-label-e1')).toHaveTextContent('text');
    // the document card's out (200, 44) to the stage's in (77, 118)
    const { mx, my } = edgePath(200, 44, 477, 218);
    expect(screen.getByTestId('edge-label-e1').style.left).toBe(`${mx}px`);
    expect(screen.getByTestId('edge-label-e1').style.top).toBe(`${my}px`);
    expect(screen.getByTestId('loop-edge-label-l1')).toHaveTextContent('↩ loop · max 3 · 2/3');
    // drawn above the nodes and never in the way of a pointer
    expect(screen.getByTestId('canvas-edges')).toHaveClass('pointer-events-none', 'z-[2000]');
    expect(
      screen.getByTestId('canvas-edges').closest('.react-flow__viewport-portal'),
    ).not.toBeNull();
  });
});
