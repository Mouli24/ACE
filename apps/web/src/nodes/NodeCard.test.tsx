import {
  NODE_CONFIG_SCHEMA_BY_KIND,
  NODE_STATES,
  NodeSchema,
  derivePorts,
  type Node,
} from '@ace/contracts';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useCanvasApi, type CanvasApi } from '../canvas/canvas-api';
import { toFlowNodes } from '../canvas/to-flow';
import { db, installMockServer, renderWithQuery } from '../test/app';
import { NodeCardView, nodeTypes, type AceFlowNode } from './NodeCard';
import { CANVAS_NODE_KINDS, ROUND_1_NODE_KINDS, createNode } from './factory';

installMockServer();

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function renderCard(node: Node, extra: Partial<Parameters<typeof NodeCardView>[0]> = {}) {
  return render(
    <ReactFlowProvider>
      <NodeCardView
        node={node}
        state="IDLE"
        selected={false}
        connectedPortIds={new Set()}
        {...extra}
      />
    </ReactFlowProvider>,
  );
}

describe('createNode (FR-NODE-001 six round-1 kinds)', () => {
  it.each(ROUND_1_NODE_KINDS)(
    '%s: builds a node that satisfies the contract with derived ports',
    (kind) => {
      const node = createNode(kind, WF, { x: 10, y: 20 });
      expect(NodeSchema.safeParse(node).success).toBe(true);
      expect(NODE_CONFIG_SCHEMA_BY_KIND[kind].safeParse(node.config).success).toBe(true);
      expect(node.position).toEqual({ x: 10, y: 20 });
      expect({ inputs: node.inputs, outputs: node.outputs }).toEqual(derivePorts(node));
    },
  );

  it('lists exactly input, agent, model, output, merge, transform', () => {
    expect(ROUND_1_NODE_KINDS).toEqual(['input', 'agent', 'model', 'output', 'merge', 'transform']);
  });
});

describe('FR-RAG-006 Retrieval node', () => {
  it('is placeable, satisfies the contract and derives a text `query` in and a json `out`', () => {
    expect(CANVAS_NODE_KINDS).toContain('retrieval');
    const node = createNode('retrieval', WF, { x: 0, y: 0 });
    expect(NodeSchema.safeParse(node).success).toBe(true);
    expect(NODE_CONFIG_SCHEMA_BY_KIND.retrieval.safeParse(node.config).success).toBe(true);
    expect(node.config).toEqual({ k: 5, mode: 'hybrid' });
    expect(node.inputs.map((p) => [p.name, p.dataType, p.multi])).toEqual([
      ['query', 'text', false],
    ]);
    expect(node.outputs.map((p) => [p.name, p.dataType])).toEqual([['out', 'json']]);
  });

  it('the card shows the base, k and mode, and says when no base is chosen', () => {
    const node = createNode('retrieval', WF, { x: 0, y: 0 });
    const { unmount } = renderCard(node);
    expect(screen.getByTestId(`retrieval-kb-${node.id}`)).toHaveTextContent('no knowledge base');
    expect(screen.getByTestId(`retrieval-k-${node.id}`)).toHaveTextContent('k 5');
    expect(screen.getByTestId(`retrieval-mode-${node.id}`)).toHaveTextContent('hybrid');
    expect(screen.getByTestId(`port-${node.id}:in:query`)).toBeInTheDocument();
    expect(screen.getByTestId(`port-${node.id}:out:out`)).toHaveAttribute('data-datatype', 'json');
    unmount();

    const configured = {
      ...node,
      config: { knowledgeBaseId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', k: 8, mode: 'keyword' },
    } as Node;
    renderCard(configured, { knowledgeBaseName: 'Team handbook' });
    expect(screen.getByTestId(`retrieval-kb-${node.id}`)).toHaveTextContent('Team handbook');
    expect(screen.getByTestId(`retrieval-k-${node.id}`)).toHaveTextContent('k 8');
    expect(screen.getByTestId(`retrieval-mode-${node.id}`)).toHaveTextContent('keyword');
  });
});

describe('NodeCardView (FR-NODE-005/006/010/012)', () => {
  it('shows the name, the kind and one handle per derived port (TC-NODE-005)', () => {
    const agent = createNode('agent', WF, { x: 0, y: 0 });
    const withImage = {
      ...agent,
      config: { ...agent.config, outputTypes: ['text', 'image'] as const },
    } as Node;
    const node = { ...withImage, ...derivePorts(withImage) } as Node;
    renderCard(node);
    expect(screen.getByText(agent.name)).toBeInTheDocument();
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByTestId(`port-${node.id}:in:text`)).toBeInTheDocument();
    expect(screen.getByTestId(`port-${node.id}:out:text`)).toBeInTheDocument();
    expect(screen.getByTestId(`port-${node.id}:out:image`)).toBeInTheDocument();
    expect(screen.queryByTestId(`port-${node.id}:in:image`)).not.toBeInTheDocument();
  });

  it('shows a "no model" chip until a model is chosen (FR-NODE-005)', () => {
    renderCard(createNode('agent', WF, { x: 0, y: 0 }));
    expect(screen.getByText('no model')).toBeInTheDocument();
  });

  it('shows the model id on the chip once set', () => {
    const agent = createNode('agent', WF, { x: 0, y: 0 });
    renderCard({ ...agent, config: { ...agent.config, modelId: 'claude-sonnet-5' } } as Node);
    expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument();
  });

  it('keeps the provider accent constant while the state changes (FR-NODE-010)', () => {
    const agent = createNode('agent', WF, { x: 0, y: 0 });
    const { rerender } = render(
      <ReactFlowProvider>
        <NodeCardView
          node={agent}
          state="IDLE"
          selected={false}
          connectedPortIds={new Set()}
          provider="anthropic"
        />
      </ReactFlowProvider>,
    );
    const card = screen.getByTestId(`node-card-${agent.id}`);
    expect(card.style.getPropertyValue('--accent-color')).toBe('var(--color-provider-anthropic)');
    expect(card).toHaveAttribute('data-state', 'IDLE');
    expect(screen.getByTestId('status-chip')).toHaveAttribute('data-state', 'IDLE');
    rerender(
      <ReactFlowProvider>
        <NodeCardView
          node={agent}
          state="RUNNING"
          selected={false}
          connectedPortIds={new Set()}
          provider="anthropic"
        />
      </ReactFlowProvider>,
    );
    expect(card.style.getPropertyValue('--accent-color')).toBe('var(--color-provider-anthropic)');
    expect(card).toHaveAttribute('data-state', 'RUNNING');
    expect(screen.getByTestId('status-chip')).toHaveAttribute('data-state', 'RUNNING');
  });

  it('marks the selected card (FR-CAN-003)', () => {
    const node = createNode('merge', WF, { x: 0, y: 0 });
    renderCard(node, { selected: true });
    expect(screen.getByTestId(`node-card-${node.id}`)).toHaveAttribute('data-selected', 'true');
  });

  it('Output node shows the round-1 placeholder (FR-NODE-012)', () => {
    renderCard(createNode('output', WF, { x: 0, y: 0 }));
    expect(screen.getByText('final result appears here after a run')).toBeInTheDocument();
  });

  it('handles are keyboard focusable and describe their port (NFR-USE-02)', () => {
    const node = createNode('input', WF, { x: 0, y: 0 });
    renderCard(node);
    const handle = screen.getByTestId(`port-${node.id}:out:text`);
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).toHaveAttribute('aria-label', expect.stringMatching(/text output/i));
  });

  it('marks a connected handle', () => {
    const node = createNode('input', WF, { x: 0, y: 0 });
    renderCard(node, { connectedPortIds: new Set([`${node.id}:out:text`]) });
    expect(screen.getByTestId(`port-${node.id}:out:text`)).toHaveAttribute(
      'data-connected',
      'true',
    );
  });
});

/* ------------------------------------------------------------------ POC Theme V2 card */

const agentNode = createNode('agent', WF, { x: 0, y: 0 });

type ViewProps = Parameters<typeof NodeCardView>[0];
function view(props: Partial<ViewProps> & Pick<ViewProps, 'node'>) {
  return render(
    <ReactFlowProvider>
      <NodeCardView state="IDLE" selected={false} connectedPortIds={new Set()} {...props} />
    </ReactFlowProvider>,
  );
}

describe('FR-NODE-010 / FR-EXE-009 the glowing card', () => {
  it('FR-NODE-010 the accent is the provider CSS variable, so Paper recolours it', () => {
    view({ node: agentNode, state: 'IDLE', provider: 'anthropic' });
    const card = screen.getByTestId(`node-card-${agentNode.id}`);
    expect(card.style.getPropertyValue('--accent-color')).toBe('var(--color-provider-anthropic)');
    expect(card).toHaveClass('ace-node');
  });

  it('FR-NODE-010 a node with no provider leaves the accent to the theme default', () => {
    view({ node: agentNode });
    expect(
      screen.getByTestId(`node-card-${agentNode.id}`).style.getPropertyValue('--accent-color'),
    ).toBe('');
  });

  it.each(NODE_STATES)('FR-EXE-009 %s drives data-state and the status chip', (state) => {
    view({ node: agentNode, state });
    expect(screen.getByTestId(`node-card-${agentNode.id}`)).toHaveAttribute('data-state', state);
    expect(screen.getByTestId('status-chip')).toHaveAttribute('data-state', state);
  });

  it('FR-ERR-007 STOPPED says it is not a failure and is never tinted danger', () => {
    view({ node: agentNode, state: 'STOPPED' });
    expect(screen.getByTestId(`stopped-note-card-${agentNode.id}`)).toHaveTextContent(
      'stopped — not a failure',
    );
    expect(
      screen.getByTestId(`node-card-${agentNode.id}`).querySelector('.text-danger'),
    ).toBeNull();
  });

  it('FR-ERR-006 BLOCKED swaps the kind icon for a lock and names the upstream node', () => {
    view({ node: agentNode, state: 'BLOCKED', blockedByName: 'Gatekeeper' });
    expect(screen.getByTestId(`blocked-lock-${agentNode.id}`)).toHaveAttribute(
      'aria-label',
      'blocked',
    );
    expect(screen.getByTestId(`blocked-by-${agentNode.id}`)).toHaveTextContent(
      'blocked by Gatekeeper',
    );
  });

  it('BR-03 FAILED shows the warning sign beside the failure words, which stay exact', () => {
    view({ node: agentNode, state: 'FAILED', failureReason: 'GUARDRAIL_VIOLATION' });
    const failure = screen.getByTestId(`failure-${agentNode.id}`);
    expect(failure.textContent).toBe('blocked by a guardrail');
    expect(failure).toHaveAttribute('data-reason', 'GUARDRAIL_VIOLATION');
    expect(failure.parentElement).toHaveTextContent('⚠ blocked by a guardrail');
    expect(failure.parentElement).toHaveClass('text-danger');
  });

  it('FR-GRD-013 WAITING says it is waiting on an approval', () => {
    view({ node: agentNode, state: 'WAITING' });
    expect(screen.getByTestId(`node-body-${agentNode.id}`)).toHaveTextContent(
      'waiting on your approval…',
    );
  });

  it.each([
    ['agent', {}, 'streamed output appears here'],
    ['model', {}, 'streamed output appears here'],
    ['merge', { mode: 'all' }, 'waits for every input'],
    ['merge', { mode: 'any' }, 'waits for the first input'],
    ['transform', { op: 'template' }, 'same result every time — no model'],
  ] as const)('FR-NODE-005 an idle %s card says what will appear (%o)', (kind, config, text) => {
    const base = createNode(kind, WF, { x: 0, y: 0 });
    view({ node: { ...base, config: { ...base.config, ...config } } as Node });
    expect(screen.getByTestId(`node-body-${base.id}`)).toHaveTextContent(text);
  });

  it.each([
    ['input', { artifactIds: [] }, 'text'],
    ['input', { artifactIds: ['01ARZ3NDEKTSV4RRFFQ69G5FA1'] }, 'text · 1 file'],
    [
      'input',
      { artifactIds: ['01ARZ3NDEKTSV4RRFFQ69G5FA1', '01ARZ3NDEKTSV4RRFFQ69G5FA2'] },
      'text · 2 files',
    ],
    ['merge', { mode: 'any' }, 'mode · any'],
    ['transform', { op: 'join' }, 'join'],
    ['output', {}, 'final result'],
    ['agent', { modelId: 'claude-sonnet-5' }, 'claude-sonnet-5'],
  ] as const)('FR-NODE-005 the %s chip reads its config (%o)', (kind, config, text) => {
    const base = createNode(kind, WF, { x: 0, y: 0 });
    view({ node: { ...base, config: { ...base.config, ...config } } as Node });
    expect(screen.getByTestId(`node-chip-${base.id}`).textContent).toBe(text);
  });

  it('FR-NODE-010 an Agent chip carries a provider dot', () => {
    view({ node: agentNode, provider: 'openai' });
    expect(
      screen.getByTestId(`node-chip-${agentNode.id}`).querySelector('[data-provider-dot]'),
    ).not.toBeNull();
  });

  it('FR-CON-006 each port row names its data type, and a connected handle takes the accent', () => {
    const input = createNode('input', WF, { x: 0, y: 0 });
    view({
      node: input,
      provider: 'anthropic',
      connectedPortIds: new Set([`${input.id}:out:text`]),
    });
    const handle = screen.getByTestId(`port-${input.id}:out:text`);
    expect(handle.style.borderColor).toBe('var(--accent-color)');
    expect(handle.style.backgroundColor).toBe('var(--accent-color)');
    expect(handle.closest('[data-port-row]')).toHaveTextContent('text');
  });

  it('preview renders port dots without React Flow handles', () => {
    view({ node: agentNode, state: 'IDLE', preview: true });
    expect(document.querySelector('.react-flow__handle')).toBeNull();
    expect(screen.getAllByTestId(/^port-dot-/)).toHaveLength(
      agentNode.inputs.length + agentNode.outputs.length,
    );
  });

  it('renders the toolbar slot inside the card', () => {
    view({ node: agentNode, toolbar: <span data-testid="slot">tools</span> });
    expect(screen.getByTestId(`node-card-${agentNode.id}`)).toContainElement(
      screen.getByTestId('slot'),
    );
  });
});

/* --------------------------------------------------------------- the node toolbar */

describe('FR-CAN-003 the selected node toolbar', () => {
  const deleteNodes = vi.fn<(ids: string[]) => void>();
  let unregister: () => void = () => undefined;

  function registerApi(extra: Partial<CanvasApi> = {}) {
    unregister();
    unregister = useCanvasApi.getState().register({
      addNode: vi.fn(),
      deleteNodes,
      fitView: vi.fn(),
      duplicateSelection: vi.fn(),
      ...extra,
    });
  }

  beforeEach(() => {
    deleteNodes.mockReset();
    usePanelsStore.setState({ sheetOpen: false, sheetTab: 'runs', chatNodeId: undefined });
    registerApi();
  });
  afterEach(() => unregister());

  function seedNodes(kinds: Array<Parameters<typeof createNode>[0]>): Node[] {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const nodes = kinds.map((kind, i) => createNode(kind, workflow.id, { x: i * 300, y: 0 }));
    db.commitGraph(workflow.id, nodes, []);
    return nodes;
  }

  function mountFlow(nodes: Node[], selectedIds: string[], onNodeDoubleClick?: () => void) {
    act(() => useSelectionStore.getState().setSelection(selectedIds, []));
    const flowNodes: AceFlowNode[] = toFlowNodes(nodes, [], undefined, () => undefined).map(
      (node) => (selectedIds.includes(node.id) ? { ...node, selected: true } : node),
    );
    renderWithQuery(
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          {/* threshold 0: a press on the card starts the drag, as a real move past it would */}
          <ReactFlow
            nodes={flowNodes}
            edges={[]}
            nodeTypes={nodeTypes}
            nodeDragThreshold={0}
            {...(onNodeDoubleClick === undefined ? {} : { onNodeDoubleClick })}
          />
        </div>
      </ReactFlowProvider>,
    );
  }

  it('shows the toolbar only for a single selection and wires its buttons', async () => {
    const [agent] = seedNodes(['agent']) as [Node];
    mountFlow([agent], [agent.id]);

    const toolbar = await screen.findByTestId(`node-toolbar-${agent.id}`);
    expect(screen.getByTestId(`node-card-${agent.id}`)).toContainElement(toolbar);
    expect(toolbar).toHaveClass('nodrag', 'nopan');

    await userEvent.click(screen.getByTestId('node-toolbar-edit'));
    expect(usePanelsStore.getState()).toMatchObject({ sheetOpen: true, sheetTab: 'configure' });

    await userEvent.click(screen.getByTestId('node-toolbar-inspect'));
    expect(usePanelsStore.getState().sheetTab).toBe('inspect');

    await userEvent.click(screen.getByTestId('node-toolbar-chat'));
    expect(usePanelsStore.getState().chatNodeId).toBe(agent.id);

    // React Flow keeps an unmeasured node `visibility: hidden` in jsdom, which blanks the computed
    // accessible name, so the label is read directly.
    const trash = screen.getByTestId('node-toolbar-delete');
    expect(trash).toHaveAttribute('aria-label', 'Delete node');
    await userEvent.click(trash);
    expect(deleteNodes).toHaveBeenCalledWith([agent.id]);
  });

  it('a double-click on the toolbar stays there: it never reaches the node’s double-click (Configure)', async () => {
    const [agent] = seedNodes(['agent']) as [Node];
    const onNodeDoubleClick = vi.fn();
    mountFlow([agent], [agent.id], onNodeDoubleClick);
    await screen.findByTestId(`node-toolbar-${agent.id}`);

    for (const id of ['node-toolbar-inspect', 'node-toolbar-chat']) {
      fireEvent.doubleClick(screen.getByTestId(id));
    }
    expect(onNodeDoubleClick).not.toHaveBeenCalled();

    // the card itself still answers a double-click
    fireEvent.doubleClick(screen.getByTestId(`node-body-${agent.id}`));
    expect(onNodeDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('FR-CHAT-004 a Merge node has no @ Chat (chat is Agent/Model only)', async () => {
    const [merge] = seedNodes(['merge']) as [Node];
    mountFlow([merge], [merge.id]);
    await screen.findByTestId(`node-toolbar-${merge.id}`);
    expect(screen.getByTestId('node-toolbar-edit')).toBeInTheDocument();
    expect(screen.queryByTestId('node-toolbar-chat')).toBeNull();
  });

  it('hides the toolbar when two nodes are selected', async () => {
    const [a, b] = seedNodes(['agent', 'model']) as [Node, Node];
    mountFlow([a, b], [a.id, b.id]);
    await screen.findByTestId(`node-card-${a.id}`);
    expect(screen.queryByTestId(/^node-toolbar-/)).toBeNull();
  });

  it('hides the toolbar while the node is dragged, and brings it back on the drop', async () => {
    const [agent] = seedNodes(['agent']) as [Node];
    mountFlow([agent], [agent.id]);
    await screen.findByTestId(`node-toolbar-${agent.id}`);

    // React Flow drags through d3-drag, which reads `event.view`; jsdom refuses its own window in
    // MouseEventInit, so the view is set on the event itself.
    const mouse = (type: string, target: EventTarget) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: 10,
      });
      Object.defineProperty(event, 'view', { value: window });
      act(() => {
        target.dispatchEvent(event);
      });
    };

    mouse('mousedown', screen.getByTestId(`node-card-${agent.id}`));
    expect(screen.queryByTestId(`node-toolbar-${agent.id}`)).toBeNull();

    mouse('mouseup', window);
    expect(await screen.findByTestId(`node-toolbar-${agent.id}`)).toBeInTheDocument();
  });

  it('FR-MOB-003 hides the toolbar on a read-only Canvas', async () => {
    registerApi({ readOnly: true });
    const [agent] = seedNodes(['agent']) as [Node];
    mountFlow([agent], [agent.id]);
    await screen.findByTestId(`node-card-${agent.id}`);
    expect(screen.queryByTestId(/^node-toolbar-/)).toBeNull();
  });

  it('shows no toolbar on an unselected node', async () => {
    const [agent] = seedNodes(['agent']) as [Node];
    mountFlow([agent], []);
    await screen.findByTestId(`node-card-${agent.id}`);
    expect(screen.queryByTestId(/^node-toolbar-/)).toBeNull();
  });
});
