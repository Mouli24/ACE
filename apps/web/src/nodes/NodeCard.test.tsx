import {
  NODE_CONFIG_SCHEMA_BY_KIND,
  NODE_STATES,
  NodeSchema,
  derivePorts,
  type Node,
} from '@ace/contracts';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen, within } from '@testing-library/react';

import { th } from '../theme/constants';
import { portAnchor } from './anchors';
import { NodeCardNotes, NodeCardView } from './NodeCard';
import { CANVAS_NODE_KINDS, ROUND_1_NODE_KINDS, createNode } from './factory';

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

type ViewProps = Parameters<typeof NodeCardView>[0];
function view(props: Partial<ViewProps> & Pick<ViewProps, 'node'>) {
  return render(
    <ReactFlowProvider>
      <NodeCardView state="IDLE" selected={false} connectedPortIds={new Set()} {...props} />
    </ReactFlowProvider>,
  );
}

const card = (node: Node) => screen.getByTestId(`node-card-${node.id}`);

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
    const { unmount } = view({ node });
    expect(screen.getByTestId(`retrieval-kb-${node.id}`)).toHaveTextContent('no knowledge base');
    expect(screen.getByTestId(`retrieval-k-${node.id}`)).toHaveTextContent('K 5');
    expect(screen.getByTestId(`retrieval-mode-${node.id}`)).toHaveTextContent('HYBRID');
    expect(screen.getByTestId(`node-meta-${node.id}`)).toHaveTextContent(
      'RETRIEVAL · K 5 · HYBRID',
    );
    expect(screen.getByTestId(`port-${node.id}:in:query`)).toBeInTheDocument();
    expect(screen.getByTestId(`port-${node.id}:out:out`)).toHaveAttribute('data-datatype', 'json');
    unmount();

    const configured = {
      ...node,
      config: { knowledgeBaseId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', k: 8, mode: 'keyword' },
    } as Node;
    view({ node: configured, knowledgeBaseName: 'Team handbook' });
    expect(screen.getByTestId(`retrieval-kb-${node.id}`)).toHaveTextContent('Team handbook');
    expect(screen.getByTestId(`retrieval-k-${node.id}`)).toHaveTextContent('K 8');
    expect(screen.getByTestId(`retrieval-mode-${node.id}`)).toHaveTextContent('KEYWORD');
  });
});

/* ------------------------------------------------------------------ D332 the Stage card */

const agentNode = createNode('agent', WF, { x: 0, y: 0 });

describe('D332 the Stage card (Agent and Model nodes)', () => {
  it('is the theme’s 210 × 280 frame with `STAGE n · NAME`, the name and the status', () => {
    const node = { ...agentNode, name: 'Script writer' } as Node;
    view({ node, stage: 2 });
    expect(card(node)).toHaveClass('h-[280px]', 'w-[210px]', 'rounded-[10px]', 'cursor-move');
    expect(screen.getByTestId(`stage-label-${node.id}`)).toHaveTextContent(
      'STAGE 2 · SCRIPT WRITER',
    );
    expect(screen.getByText('Script writer')).toBeInTheDocument();
    expect(screen.getByTestId('status-chip')).toHaveTextContent('Idle');
  });

  it('the sub line is the provider record and the model, or says what is missing', () => {
    const { unmount } = view({ node: agentNode, stage: 1 });
    expect(screen.getByTestId(`stage-sub-${agentNode.id}`)).toHaveTextContent(
      'no provider · no model',
    );
    unmount();

    const configured = {
      ...agentNode,
      config: { ...agentNode.config, modelId: 'claude-sonnet-5' },
    } as Node;
    view({ node: configured, stage: 1, provider: 'anthropic', providerName: 'Claude' });
    expect(screen.getByTestId(`stage-sub-${agentNode.id}`)).toHaveTextContent(
      'Claude · claude-sonnet-5',
    );
  });

  it.each(NODE_STATES)('FR-EXE-009 %s sets data-state and the status row', (state) => {
    view({ node: agentNode, state, stage: 1 });
    expect(card(agentNode)).toHaveAttribute('data-state', state);
    expect(screen.getByTestId('status-chip')).toHaveAttribute('data-state', state);
  });

  it.each([
    ['COMPLETED', 'Done', '#2f9e63'],
    ['RUNNING', 'Running', '#ef6b3f'],
    ['FAILED', 'Failed', '#c94c27'],
    ['BLOCKED', 'Blocked', '#c94c27'],
    ['WAITING', 'Waiting', '#a39d97'],
  ] as const)('the status row of a %s node reads "%s" beside a %s dot', (state, word, colour) => {
    view({ node: agentNode, state, stage: 1 });
    const status = screen.getByTestId('status-chip');
    expect(status).toHaveTextContent(word);
    expect((status.querySelector('span') as HTMLElement).style.background).toBe(
      // jsdom normalises hex to rgb()
      `rgb(${parseInt(colour.slice(1, 3), 16)}, ${parseInt(colour.slice(3, 5), 16)}, ${parseInt(
        colour.slice(5, 7),
        16,
      )})`,
    );
  });

  it('FR-NODE-010 the border is the provider glow at 0.38; selected, the provider colour and ring', () => {
    const look = th({ provider: 'Claude Code' }, false);
    // PG-1.3 (D351): the node names its provider, as a node drawn with a provider look always does.
    const onProvider = {
      ...agentNode,
      config: { ...agentNode.config, providerId: 'p-anthropic' },
    } as Node;
    const { unmount } = view({ node: onProvider, stage: 1, provider: 'anthropic' });
    expect(card(agentNode).style.border).toBe(
      `1px solid rgba(${look.glow.replace(/,/g, ', ')}, 0.38)`,
    );
    expect(card(agentNode).style.boxShadow).toBe('none');
    unmount();

    view({ node: onProvider, stage: 1, provider: 'anthropic', selected: true });
    expect(card(agentNode)).toHaveAttribute('data-selected', 'true');
    expect(card(agentNode).style.boxShadow).toBe(
      '0 0 0 2px #d97757, 0 12px 40px -16px rgba(217,119,87,0.55)',
    );
    expect(card(agentNode).style.border).toContain('1px solid');
    expect(card(agentNode).style.border).not.toContain('0.38');
  });

  it('a Custom look (mock, Ollama) takes the frame line, and #bdb6ae when selected', () => {
    // D351 (PG-1.3) replaces the "no provider" half of this case: that card is now red, below.
    const onMock = { ...agentNode, config: { ...agentNode.config, providerId: 'p-mock' } } as Node;
    const { unmount } = view({ node: onMock, stage: 1, provider: 'mock' });
    expect(card(agentNode).style.border).toBe('1px solid var(--frameLine)');
    unmount();
    view({ node: onMock, stage: 1, provider: 'ollama', selected: true });
    expect(card(agentNode).style.boxShadow).toBe(
      '0 0 0 2px #bdb6ae, 0 12px 40px -16px rgba(150,140,130,0.55)',
    );
  });

  it('PG-1.3 a node with no provider, or a provider that is gone, is a red "Choose a provider" card', () => {
    const { unmount } = view({ node: agentNode, stage: 1 });
    expect(card(agentNode)).toHaveAttribute('data-needs-provider', 'true');
    expect(card(agentNode).style.border).toBe('1px solid rgb(201, 76, 39)');
    expect(
      within(card(agentNode)).getByRole('button', { name: /Choose a provider/ }),
    ).toBeVisible();
    unmount();

    const imported = {
      ...agentNode,
      config: { ...agentNode.config, providerId: 'p-elsewhere', modelId: 'mock-text' },
    } as Node;
    const { unmount: gone } = view({ node: imported, stage: 1, providerMissing: true });
    expect(within(card(agentNode)).getByText('Choose a provider')).toBeVisible();
    gone();

    const fine = { ...imported, config: { ...imported.config, providerId: 'p-mock' } } as Node;
    view({ node: fine, stage: 1, provider: 'mock' });
    expect(card(agentNode)).not.toHaveAttribute('data-needs-provider');
    expect(within(card(agentNode)).queryByText('Choose a provider')).toBeNull();
  });

  it('the orb carries the provider’s gradient, ring and logo, light or dark', () => {
    const { unmount } = view({ node: agentNode, stage: 1, provider: 'google' });
    const light = th({ provider: 'Gemini CLI' }, false);
    const orb = screen.getByTestId(`stage-orb-${agentNode.id}`);
    expect(orb.style.background).toContain('radial-gradient');
    expect(orb.querySelector('img')).toHaveAttribute('src', light.logo);
    expect(orb.querySelector('img')?.style.filter).toBe('brightness(0) invert(1)');
    const lightShadow = orb.style.boxShadow;
    unmount();

    view({ node: agentNode, stage: 1, provider: 'google', dark: true });
    expect(screen.getByTestId(`stage-orb-${agentNode.id}`).style.boxShadow).not.toBe(lightShadow);
  });
});

/* ------------------------------------------------------------------ D332 the Document card */

describe('D332 the Document card (every other kind)', () => {
  it.each([
    ['input', { artifactIds: [] }, 'INPUT · TEXT'],
    ['input', { artifactIds: ['01ARZ3NDEKTSV4RRFFQ69G5FA1'] }, 'INPUT · 1 FILE'],
    [
      'input',
      { artifactIds: ['01ARZ3NDEKTSV4RRFFQ69G5FA1', '01ARZ3NDEKTSV4RRFFQ69G5FA2'] },
      'INPUT · 2 FILES',
    ],
    ['merge', { mode: 'any' }, 'MERGE · ANY'],
    ['merge', { mode: 'all' }, 'MERGE · ALL'],
    ['transform', { op: 'template' }, 'TRANSFORM · TEMPLATE'],
    ['transform', { op: 'extract_json_field' }, 'TRANSFORM · EXTRACT JSON FIELD'],
    ['output', {}, 'OUTPUT'],
  ] as const)('FR-NODE-005 the %s meta line reads its config (%o)', (kind, config, text) => {
    const base = createNode(kind, WF, { x: 0, y: 0 });
    view({ node: { ...base, config: { ...base.config, ...config } } as Node });
    expect(screen.getByTestId(`node-meta-${base.id}`).textContent).toBe(text);
    expect(card(base)).toHaveClass('w-[200px]', 'rounded-[8px]');
  });

  it('an Output node’s meta names the types arriving on it', () => {
    const output = createNode('output', WF, { x: 0, y: 0 });
    view({ node: output, receives: ['json'] });
    expect(screen.getByTestId(`node-meta-${output.id}`)).toHaveTextContent('OUTPUT · JSON');
  });

  it('FR-MM-007 the files count keeps its testid on the Input card', () => {
    const base = createNode('input', WF, { x: 0, y: 0 });
    view({
      node: {
        ...base,
        config: { ...base.config, artifactIds: ['01ARZ3NDEKTSV4RRFFQ69G5FA1'] },
      } as Node,
    });
    expect(screen.getByTestId(`input-attachment-count-${base.id}`)).toHaveTextContent('1 FILE');
  });

  it('the description is a real excerpt — the start text, the template — or is left out', () => {
    const input = createNode('input', WF, { x: 0, y: 0 });
    const { unmount } = view({
      node: { ...input, config: { ...input.config, text: 'Summarise the launch notes.' } } as Node,
    });
    expect(screen.getByTestId(`node-description-${input.id}`)).toHaveTextContent(
      'Summarise the launch notes.',
    );
    unmount();

    const transform = createNode('transform', WF, { x: 0, y: 0 });
    const { unmount: gone } = view({
      node: { ...transform, config: { op: 'template', template: 'Dear {{name}}' } } as Node,
    });
    expect(screen.getByTestId(`node-description-${transform.id}`)).toHaveTextContent(
      'Dear {{name}}',
    );
    gone();

    const merge = createNode('merge', WF, { x: 0, y: 0 });
    view({ node: merge });
    expect(screen.queryByTestId(`node-description-${merge.id}`)).toBeNull();
  });

  it('cuts a long excerpt at 120 characters', () => {
    const input = createNode('input', WF, { x: 0, y: 0 });
    view({ node: { ...input, config: { ...input.config, text: 'x'.repeat(400) } } as Node });
    const text = screen.getByTestId(`node-description-${input.id}`).textContent ?? '';
    expect(text.length).toBe(120);
    expect(text.endsWith('…')).toBe(true);
  });

  it('says "Attached to Stage n" only when its output feeds a stage', () => {
    const input = createNode('input', WF, { x: 0, y: 0 });
    const { unmount } = view({ node: input });
    expect(screen.queryByTestId(`node-attached-${input.id}`)).toBeNull();
    unmount();

    const { unmount: next } = view({ node: input, feeds: [1] });
    expect(screen.getByTestId(`node-attached-${input.id}`)).toHaveTextContent(
      'Attached to Stage 1',
    );
    next();

    view({ node: input, feeds: [1, 3] });
    expect(screen.getByTestId(`node-attached-${input.id}`)).toHaveTextContent(
      'Attached to Stages 1, 3',
    );
  });

  it('a selected document card takes the #ef6b3f border (FR-CAN-003)', () => {
    const merge = createNode('merge', WF, { x: 0, y: 0 });
    const { unmount } = view({ node: merge });
    expect(card(merge).style.border).toBe('1px solid var(--line)');
    unmount();
    view({ node: merge, selected: true });
    expect(card(merge)).toHaveAttribute('data-selected', 'true');
    expect(card(merge).style.border).toBe('1px solid rgb(239, 107, 63)');
  });
});

/* ------------------------------------------------------------------ handles */

describe('D332 ports: invisible handles at the theme’s anchors', () => {
  it('one handle per derived port, keyboard focusable and describing its port (NFR-USE-02)', () => {
    const withImage = {
      ...agentNode,
      config: { ...agentNode.config, outputTypes: ['text', 'image'] as const },
    } as Node;
    const node = { ...withImage, ...derivePorts(withImage) } as Node;
    view({ node, stage: 1 });
    expect(screen.getByTestId(`port-${node.id}:in:text`)).toBeInTheDocument();
    expect(screen.getByTestId(`port-${node.id}:out:text`)).toBeInTheDocument();
    expect(screen.getByTestId(`port-${node.id}:out:image`)).toBeInTheDocument();
    expect(screen.queryByTestId(`port-${node.id}:in:image`)).not.toBeInTheDocument();
    const handle = screen.getByTestId(`port-${node.id}:out:text`);
    expect(handle).toHaveAttribute('tabindex', '0');
    expect(handle).toHaveAttribute('aria-label', expect.stringMatching(/text output/i));
    expect(handle).toHaveClass('ace-port');
  });

  it('a stage’s ports sit at (77, 118) in and (133, 118) out; two outputs 16 px apart', () => {
    const withImage = {
      ...agentNode,
      config: { ...agentNode.config, outputTypes: ['text', 'image'] as const },
    } as Node;
    const node = { ...withImage, ...derivePorts(withImage) } as Node;
    view({ node, stage: 1 });
    // positioned inside the 1px border, so the centre lands on the anchor of the outer box
    const input = screen.getByTestId(`port-${node.id}:in:text`);
    expect([input.style.left, input.style.top]).toEqual(['76px', '117px']);
    const [text, image] = [
      screen.getByTestId(`port-${node.id}:out:text`),
      screen.getByTestId(`port-${node.id}:out:image`),
    ];
    expect([text.style.left, text.style.top]).toEqual(['132px', '109px']);
    expect([image.style.left, image.style.top]).toEqual(['132px', '125px']);
    expect(text.style.transform).toBe('translate(-50%, -50%)');
  });

  it('a document card’s ports sit at (0, 44) in and (200, 44) out', () => {
    expect(portAnchor('merge', 'out', 0, 1)).toEqual({ x: 200, y: 44 });
    expect(portAnchor('merge', 'in', 0, 2)).toEqual({ x: 0, y: 36 });
    expect(portAnchor('merge', 'in', 1, 2)).toEqual({ x: 0, y: 52 });
    const input = createNode('input', WF, { x: 0, y: 0 });
    view({ node: input });
    const handle = screen.getByTestId(`port-${input.id}:out:text`);
    expect([handle.style.left, handle.style.top]).toEqual(['199px', '43px']);
  });

  it('marks a connected handle and an armed one', () => {
    const node = createNode('input', WF, { x: 0, y: 0 });
    view({
      node,
      connectedPortIds: new Set([`${node.id}:out:text`]),
      armedPortId: `${node.id}:out:text`,
    });
    const handle = screen.getByTestId(`port-${node.id}:out:text`);
    expect(handle).toHaveAttribute('data-connected', 'true');
    expect(handle).toHaveAttribute('data-armed', 'true');
  });

  it('a stack too tall to centre on (44) starts 12 px below the card’s top, 16 px apart', () => {
    const output = createNode('output', WF, { x: 0, y: 0 });
    const count = output.inputs.length;
    expect(count).toBeGreaterThan(5);
    expect(portAnchor('output', 'in', 0, count)).toEqual({ x: 0, y: 12 });
    expect(portAnchor('output', 'in', 1, count)).toEqual({ x: 0, y: 28 });
  });
});

/* ------------------------------------------------------------------ the notes under the card */

describe('D332 what the card has no room for, under it', () => {
  const notes = (props: Partial<Parameters<typeof NodeCardNotes>[0]> = {}) =>
    render(<NodeCardNotes node={agentNode} state="IDLE" {...props} />);

  it('says nothing for an idle node', () => {
    notes();
    expect(screen.queryByTestId(`node-notes-${agentNode.id}`)).toBeNull();
  });

  it('FR-ERR-006 a BLOCKED node names the upstream node', () => {
    notes({ state: 'BLOCKED', blockedByName: 'Gatekeeper' });
    expect(screen.getByTestId(`blocked-by-${agentNode.id}`)).toHaveTextContent(
      'blocked by Gatekeeper',
    );
  });

  it('BR-03 a FAILED node says which kind of failure, in the contract’s exact words', () => {
    notes({ state: 'FAILED', failureReason: 'GUARDRAIL_VIOLATION' });
    const failure = screen.getByTestId(`failure-${agentNode.id}`);
    expect(failure.textContent).toBe('blocked by a guardrail');
    expect(failure).toHaveAttribute('data-reason', 'GUARDRAIL_VIOLATION');
  });

  it('FR-PRV-005 says when the provider is gone', () => {
    notes({ providerMissing: true });
    expect(screen.getByTestId(`provider-missing-${agentNode.id}`)).toHaveTextContent(
      'provider missing',
    );
  });

  it('D285 a running stage points at the chat', () => {
    notes({ state: 'RUNNING' });
    expect(screen.getByTestId(`running-note-${agentNode.id}`)).toHaveTextContent(
      'running — answer in Chat',
    );
  });
});
