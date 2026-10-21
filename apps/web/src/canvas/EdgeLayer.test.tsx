import type { Edge, LoopConfig, Node, NodeState, ServerFrame } from '@ace/contracts';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { act, render, screen } from '@testing-library/react';

import { createNode } from '../nodes/factory';
import { useRunStore } from '../runs/run-store';
import { EdgeChip, EdgeLayer, EdgeStroke } from './EdgeLayer';
import { FLOW_RECENT_MS, edgeFlowState, type EdgeFlow, type EdgeRunFacts } from './edge-flow';
import { toFlowEdges, toFlowNodes } from './to-flow';
import { edgePath } from './viewport';

const WF = '01WF00000000000000000000000';
/** The layer reads positions only; the cards themselves are not under test here. */
const nodeTypes = { ace: () => <div /> };
/** D390: what an edge's `<title>` says (inside its group, so `getByTitle` does not reach it). */
const titleOf = (id: string) =>
  screen.getByTestId(`edge-line-${id}`).querySelector('title')?.textContent;

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

describe('D390 edges show run state: the flow-state mapping', () => {
  const facts = (sourceState: NodeState, summary?: string): EdgeRunFacts => ({
    sourceState,
    summary,
  });

  it.each<[string, EdgeRunFacts | undefined, boolean, EdgeFlow]>([
    ['no run on show', undefined, false, 'none'],
    ['the source is running', facts('RUNNING'), false, 'flowing'],
    ['a transfer under 2 s old', facts('COMPLETED', 'text · ~3 tokens'), true, 'flowing'],
    ['an envelope crossed it', facts('COMPLETED', 'text · ~3 tokens'), false, 'delivered'],
    [
      'a loop source running again over a delivered edge',
      facts('RUNNING', 'text'),
      false,
      'flowing',
    ],
    ['the source has not started', facts('IDLE'), false, 'waiting'],
    ['the source is ready', facts('READY'), false, 'waiting'],
    ['the source waits on a person', facts('WAITING'), false, 'waiting'],
    ['the source is paused', facts('PAUSED'), false, 'waiting'],
    ['the source finished and sent nothing here', facts('COMPLETED'), false, 'waiting'],
    ['the source failed before sending', facts('FAILED'), false, 'cut'],
    ['the source was stopped before sending', facts('STOPPED'), false, 'cut'],
    ['the source was blocked before sending', facts('BLOCKED'), false, 'cut'],
    [
      'the source failed after it had sent',
      facts('FAILED', 'text · ~3 tokens'),
      false,
      'delivered',
    ],
  ])('%s → %s', (_what, given, recent, expected) => {
    expect(edgeFlowState(given, recent)).toBe(expected);
  });
});

describe('D390 edges show run state: EdgeStroke draws each flow', () => {
  const draw = (flow: EdgeFlow, title?: string) =>
    render(
      <svg>
        <EdgeStroke
          id="e1"
          d="M0 0 C50 0 50 10 100 10"
          x1={0}
          y1={0}
          x2={100}
          y2={10}
          selected={false}
          flow={flow}
          title={title}
        />
      </svg>,
    );
  const line = () =>
    screen.getByTestId('edge-line-e1').querySelectorAll('path')[1] as SVGPathElement;

  it('none is the theme’s flowing dashes, exactly as before', () => {
    draw('none');
    expect(screen.getByTestId('edge-line-e1')).toHaveAttribute('data-flow', 'none');
    expect(line()).toHaveClass('ace-edge-flow');
    expect(line().style.strokeDasharray).toBe('5 5');
    expect(line().style.stroke).toBe('#ef6b3f');
    expect(screen.getByTestId('edge-line-e1').querySelector('title')).toBeNull();
  });

  it('delivered is a solid line that does not move, titled with the summary', () => {
    draw('delivered', 'delivered: text · ~3 tokens');
    expect(screen.getByTestId('edge-line-e1')).toHaveAttribute('data-flow', 'delivered');
    expect(line()).not.toHaveClass('ace-edge-flow');
    expect(line().style.strokeDasharray).toBe('');
    expect(titleOf('e1')).toBe('delivered: text · ~3 tokens');
  });

  it('flowing keeps the animated dashes', () => {
    draw('flowing');
    expect(line()).toHaveClass('ace-edge-flow');
    expect(line().style.strokeDasharray).toBe('5 5');
  });

  it('waiting is dim and still', () => {
    draw('waiting');
    expect(line()).not.toHaveClass('ace-edge-flow');
    expect(line().style.strokeDasharray).toBe('5 5');
    expect(line().style.opacity).toBe('0.55');
    expect(line().style.stroke).toBe('var(--muted)');
  });

  it('cut is still, in the failed red', () => {
    draw('cut', 'cut off: Writer failed');
    expect(line()).not.toHaveClass('ace-edge-flow');
    expect(line().style.strokeDasharray).toBe('5 5');
    expect(line().style.stroke).toBe('var(--color-status-FAILED)');
    expect(titleOf('e1')).toBe('cut off: Writer failed');
  });
});

describe('D390 edges show run state: the edge layer reads the run overlay', () => {
  const RUN = '01RUN0000000000000000000000';
  const usage = { tokensIn: 0, tokensOut: 0, costUsd: 0, priceTableVersion: 'mock-v1' };
  let seq = 0;

  /** Brief → Writer → Reviewer, and a loop back from the Reviewer to the Writer. */
  function graph() {
    const input = { ...createNode('input', WF, { x: 0, y: 0 }), name: 'Brief' } as Node;
    const writer = { ...createNode('agent', WF, { x: 400, y: 100 }), name: 'Writer' } as Node;
    const reviewer = { ...createNode('agent', WF, { x: 800, y: 100 }), name: 'Reviewer' } as Node;
    const loop: LoopConfig = {
      maxIterations: 3,
      exitCondition: { path: 'ok', equals: true },
      onMax: 'continue',
    };
    const edge = (id: string, from: Node, to: Node, kind: 'data' | 'loop' = 'data'): Edge => ({
      id,
      workflowId: WF,
      kind,
      from: { nodeId: from.id, portId: from.outputs[0]!.id },
      to: { nodeId: to.id, portId: to.inputs[0]!.id },
      ...(kind === 'loop' ? { loop } : {}),
    });
    const edges = [
      edge('e-in', input, writer),
      edge('e-out', writer, reviewer),
      edge('l-back', reviewer, writer, 'loop'),
    ];
    const nodes = [input, writer, reviewer];
    render(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow
            nodes={toFlowNodes(nodes, edges, undefined, () => undefined)}
            edges={[]}
            nodeTypes={nodeTypes}
          >
            <EdgeLayer nodes={nodes} edges={toFlowEdges(edges, nodes)} />
          </ReactFlow>
        </div>
      </ReactFlowProvider>,
    );
    return { input, writer, reviewer };
  }

  const flowOf = (id: string) => screen.getByTestId(`edge-line-${id}`).getAttribute('data-flow');

  const nodeState = (node: Node, status: NodeState): ServerFrame =>
    ({
      seq: ++seq,
      type: 'node.state',
      payload: {
        runId: RUN,
        nodeRunId: `NR-${node.id}`,
        nodeId: node.id,
        iteration: 1,
        attempt: 1,
        status,
      },
    }) as ServerFrame;

  const transfer = (id: string, from: Node, to: Node): ServerFrame =>
    ({
      seq: ++seq,
      type: 'edge.transfer',
      payload: {
        runId: RUN,
        edgeId: id,
        fromNodeId: from.id,
        toNodeId: to.id,
        iteration: 1,
        summary: 'text · ~4 tokens',
      },
    }) as ServerFrame;

  afterEach(() => {
    vi.useRealTimers();
    act(() => useRunStore.getState().reset());
  });

  it('with no run on show every edge keeps the theme’s look', () => {
    graph();
    expect(flowOf('e-in')).toBe('none');
    expect(flowOf('e-out')).toBe('none');
    expect(flowOf('l-back')).toBe('none');
  });

  it('another workflow’s run leaves this Canvas’s edges as they are', () => {
    act(() => useRunStore.getState().begin('01OTHERWORKFLOW00000000000', RUN, 'RUNNING'));
    graph();
    expect(flowOf('e-in')).toBe('none');
  });

  it('follows a live run: waiting, flowing while the source runs, then delivered; a loop keeps its look', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { input, writer, reviewer } = graph();
    act(() => useRunStore.getState().begin(WF, RUN, 'RUNNING'));
    expect(flowOf('e-in')).toBe('waiting');
    expect(flowOf('e-out')).toBe('waiting');
    expect(titleOf('e-out')).toBe('waiting: Writer is idle');

    act(() => useRunStore.getState().apply(nodeState(input, 'RUNNING')));
    expect(flowOf('e-in')).toBe('flowing');

    act(() => {
      useRunStore.getState().apply(nodeState(input, 'COMPLETED'));
      useRunStore.getState().apply(transfer('e-in', input, writer));
    });
    // just crossed: still moving for 2 s, then solid
    expect(flowOf('e-in')).toBe('flowing');
    act(() => vi.advanceTimersByTime(FLOW_RECENT_MS + 10));
    expect(flowOf('e-in')).toBe('delivered');
    expect(titleOf('e-in')).toBe('delivered: text · ~4 tokens');

    // the loop edge is not a data edge: its look never changes
    act(() => useRunStore.getState().apply(nodeState(reviewer, 'FAILED')));
    expect(flowOf('l-back')).toBe('none');
  });

  it('a source that failed, stopped or was blocked before sending cuts its edge', () => {
    const { input, writer } = graph();
    act(() => {
      useRunStore.getState().begin(WF, RUN, 'RUNNING');
      useRunStore.getState().apply(nodeState(input, 'COMPLETED'));
      useRunStore.getState().apply(transfer('e-in', input, writer));
      useRunStore.getState().apply(nodeState(writer, 'FAILED'));
    });
    expect(flowOf('e-out')).toBe('cut');
    expect(titleOf('e-out')).toBe('cut off: Writer failed');

    act(() => useRunStore.getState().apply(nodeState(writer, 'STOPPED')));
    expect(titleOf('e-out')).toBe('cut off: Writer stopped');
  });

  it('an adopted run reads what crossed each edge from its node runs’ envelopes', () => {
    const { input, writer, reviewer } = graph();
    act(() =>
      useRunStore
        .getState()
        .adopt(WF, { id: RUN, status: 'HALTED', haltReason: 'stopped', totals: usage }, [
          { id: 'NR-in', nodeId: input.id, iteration: 1, attempt: 1, status: 'COMPLETED', usage },
          {
            id: 'NR-w',
            nodeId: writer.id,
            iteration: 1,
            attempt: 1,
            status: 'STOPPED',
            usage,
            inputEnvelopes: [
              {
                fromNodeId: input.id,
                toNodeId: writer.id,
                reads: [{ type: 'text', text: 'Write a haiku.' }],
              },
            ],
          },
          { id: 'NR-r', nodeId: reviewer.id, iteration: 1, attempt: 1, status: 'IDLE', usage },
        ]),
    );
    // read back, never "just crossed": solid at once
    expect(flowOf('e-in')).toBe('delivered');
    expect(titleOf('e-in')).toMatch(/^delivered: text · ~\d+ tokens$/);
    expect(flowOf('e-out')).toBe('cut');
  });
});
