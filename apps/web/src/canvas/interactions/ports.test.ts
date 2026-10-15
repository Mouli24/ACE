import { derivePorts, type Edge, type Node } from '@ace/contracts';

import { createNode } from '../../nodes/factory';
import { checkConnection } from '../connect';
import {
  CLICK_SLOP_PX,
  connectChoices,
  dropOnCard,
  isCardBody,
  isClick,
  portConnectStates,
  type CheckConnection,
} from './ports';

const WF = '01WF00000000000000000000000';

/** An Agent taking and giving the given data types (one port per type). */
function agent(name: string, inputTypes: string[], outputTypes: string[] = ['text']): Node {
  const base = createNode('agent', WF, { x: 0, y: 0 });
  const node = {
    ...base,
    name,
    config: { ...base.config, inputTypes, outputTypes },
  } as Node;
  return { ...node, ...derivePorts(node as Parameters<typeof derivePorts>[0]) } as Node;
}

/** The Canvas's rule, without the loop offer: the contract plus the cycle check. */
const ruleFor =
  (nodes: Node[], edges: Edge[] = []): CheckConnection =>
  (attempt) => {
    const verdict = checkConnection(nodes, edges, attempt);
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
  };

describe('PG-1.1 portConnectStates — which ports show while a line is drawn (D350)', () => {
  it('marks the start port, compatible inputs, and incompatible inputs with their reason', () => {
    const writer = agent('Writer', ['text']);
    const editor = agent('Editor', ['text']);
    const painter = agent('Painter', ['image']);
    const nodes = [writer, editor, painter];
    const out = writer.outputs[0]!;
    const states = portConnectStates(
      nodes,
      { nodeId: writer.id, portId: out.id, type: 'source' },
      ruleFor(nodes),
    );
    expect(states.get(out.id)).toEqual({ look: 'source' });
    expect(states.get(editor.inputs[0]!.id)).toEqual({ look: 'compatible' });
    const image = states.get(painter.inputs[0]!.id);
    expect(image?.look).toBe('incompatible');
    expect(image?.look === 'incompatible' && image.reason).toMatch(/image/i);
  });

  it('leaves out ports on the same side as the start and the start node’s own ports', () => {
    const writer = agent('Writer', ['text']);
    const editor = agent('Editor', ['text']);
    const nodes = [writer, editor];
    const states = portConnectStates(
      nodes,
      { nodeId: writer.id, portId: writer.outputs[0]!.id, type: 'source' },
      ruleFor(nodes),
    );
    expect(states.has(editor.outputs[0]!.id)).toBe(false);
    expect(states.has(writer.inputs[0]!.id)).toBe(false);
  });

  it('drawn backwards from an input, the other nodes’ outputs are the candidates', () => {
    const writer = agent('Writer', ['text']);
    const editor = agent('Editor', ['text']);
    const nodes = [writer, editor];
    const states = portConnectStates(
      nodes,
      { nodeId: editor.id, portId: editor.inputs[0]!.id, type: 'target' },
      ruleFor(nodes),
    );
    expect(states.get(writer.outputs[0]!.id)).toEqual({ look: 'compatible' });
  });
});

describe('PG-1.1 dropOnCard — a line dropped on a card body (D350)', () => {
  it('connects to the card’s only compatible input', () => {
    const writer = agent('Writer', ['text']);
    const editor = agent('Editor', ['image', 'text']);
    const nodes = [writer, editor];
    const outcome = dropOnCard(
      nodes,
      { nodeId: writer.id, portId: writer.outputs[0]!.id, type: 'source' },
      editor.id,
      ruleFor(nodes),
    );
    expect(outcome.kind).toBe('connect');
    if (outcome.kind !== 'connect') return;
    expect(outcome.choice.to.dataType).toBe('text');
    expect(outcome.choice.attempt).toEqual({
      source: writer.id,
      sourceHandle: writer.outputs[0]!.id,
      target: editor.id,
      targetHandle: editor.inputs.find((p) => p.dataType === 'text')!.id,
    });
  });

  it('offers a chooser listing every input that fits, in order, when more than one does', () => {
    const writer = agent('Writer', ['text']);
    const editor = agent('Editor', ['text']);
    const second = { ...editor.inputs[0]!, id: `${editor.id}:in:second`, name: 'second' };
    const twoInputs = { ...editor, inputs: [editor.inputs[0]!, second] } as Node;
    const nodes = [writer, twoInputs];
    const outcome = dropOnCard(
      nodes,
      { nodeId: writer.id, portId: writer.outputs[0]!.id, type: 'source' },
      twoInputs.id,
      ruleFor(nodes),
    );
    expect(outcome.kind).toBe('choose');
    expect(outcome.kind === 'choose' && outcome.choices.map((c) => c.to.name)).toEqual([
      twoInputs.inputs[0]!.name,
      'second',
    ]);
  });

  it('refuses with the reason when no input fits', () => {
    const writer = agent('Writer', ['text']);
    const painter = agent('Painter', ['image']);
    const nodes = [writer, painter];
    const outcome = dropOnCard(
      nodes,
      { nodeId: writer.id, portId: writer.outputs[0]!.id, type: 'source' },
      painter.id,
      ruleFor(nodes),
    );
    expect(outcome.kind).toBe('refuse');
    expect(outcome.kind === 'refuse' && outcome.reason).toMatch(/image/i);
  });

  it('refuses a drop back on the card the line started from', () => {
    const writer = agent('Writer', ['text']);
    const outcome = dropOnCard(
      [writer],
      { nodeId: writer.id, portId: writer.outputs[0]!.id, type: 'source' },
      writer.id,
      ruleFor([writer]),
    );
    expect(outcome.kind).toBe('refuse');
  });

  it('a line drawn from an input and dropped on a card takes that card’s output', () => {
    const writer = agent('Writer', ['text']);
    const editor = agent('Editor', ['text']);
    const nodes = [writer, editor];
    const outcome = dropOnCard(
      nodes,
      { nodeId: editor.id, portId: editor.inputs[0]!.id, type: 'target' },
      writer.id,
      ruleFor(nodes),
    );
    expect(outcome.kind).toBe('connect');
    expect(outcome.kind === 'connect' && outcome.choice.attempt.source).toBe(writer.id);
  });
});

describe('PG-1.1 connectChoices — the ⋯ menu’s "Connect to…" (D350)', () => {
  it('pairs this node’s outputs with the picked node’s inputs the rule accepts', () => {
    const writer = agent('Writer', ['text']);
    const editor = agent('Editor', ['text']);
    const nodes = [writer, editor];
    const outcome = connectChoices(nodes, writer.id, editor.id, ruleFor(nodes));
    expect(outcome.kind).toBe('connect');
  });

  it('refuses a pick that would close a cycle, with the reason', () => {
    const writer = agent('Writer', ['text']);
    const editor = agent('Editor', ['text']);
    const nodes = [writer, editor];
    const edges: Edge[] = [
      {
        id: 'e1',
        workflowId: WF,
        kind: 'data',
        from: { nodeId: writer.id, portId: writer.outputs[0]!.id },
        to: { nodeId: editor.id, portId: editor.inputs[0]!.id },
      },
    ];
    const outcome = connectChoices(nodes, editor.id, writer.id, ruleFor(nodes, edges));
    expect(outcome.kind).toBe('refuse');
    expect(outcome.kind === 'refuse' && outcome.reason).toMatch(/cycle/i);
  });

  it('refuses connecting a node to itself', () => {
    const writer = agent('Writer', ['text']);
    expect(connectChoices([writer], writer.id, writer.id, ruleFor([writer])).kind).toBe('refuse');
  });
});

describe('PG-1.1 isClick — settings open on a click, never after a drag (D350)', () => {
  it(`is a click up to ${CLICK_SLOP_PX} px of travel and a drag beyond`, () => {
    expect(isClick({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(isClick({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(true);
    expect(isClick({ x: 10, y: 10 }, { x: 14, y: 14 })).toBe(false);
    expect(isClick({ x: 10, y: 10 }, { x: 60, y: 10 })).toBe(false);
  });

  it('a click with no press seen (keyboard, synthetic) is still a click', () => {
    expect(isClick(undefined, { x: 0, y: 0 })).toBe(true);
  });
});

describe('PG-1.1 isCardBody — only the card itself opens settings (D350)', () => {
  function card(inner: string): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `<div data-node-card>${inner}</div>`;
    return root;
  }

  it('the card body is, a port, a card button and a menu item are not', () => {
    const root = card(
      '<span id="body">name</span><div class="react-flow__handle" id="port"></div><button id="btn"><svg id="icon"></svg></button><div role="menuitem" id="item"></div>',
    );
    expect(isCardBody(root.querySelector('#body'))).toBe(true);
    expect(isCardBody(root.querySelector('#port'))).toBe(false);
    expect(isCardBody(root.querySelector('#btn'))).toBe(false);
    expect(isCardBody(root.querySelector('#icon'))).toBe(false);
    expect(isCardBody(root.querySelector('#item'))).toBe(false);
  });

  it('what hangs outside the card is not', () => {
    const outside = document.createElement('span');
    expect(isCardBody(outside)).toBe(false);
    expect(isCardBody(null)).toBe(false);
  });
});
