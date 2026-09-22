import { NODE_CONFIG_SCHEMA_BY_KIND, NodeSchema, derivePorts, type Node } from '@ace/contracts';
import { STATUS_RING, PROVIDER_ACCENT } from '@ace/ui';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';

import { NodeCardView } from './NodeCard';
import { ROUND_1_NODE_KINDS, createNode } from './factory';

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

  it('keeps the provider accent constant while the status ring changes (FR-NODE-010)', () => {
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
    expect(card.style.getPropertyValue('--accent-color')).toBe(PROVIDER_ACCENT.anthropic);
    expect(card.style.getPropertyValue('--ring-color')).toBe(STATUS_RING.IDLE);
    expect(card).toHaveAttribute('data-state', 'IDLE');
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
    expect(card.style.getPropertyValue('--accent-color')).toBe(PROVIDER_ACCENT.anthropic);
    expect(card.style.getPropertyValue('--ring-color')).toBe(STATUS_RING.RUNNING);
    expect(card).toHaveAttribute('data-state', 'RUNNING');
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
