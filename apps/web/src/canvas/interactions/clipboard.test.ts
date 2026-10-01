import type { Edge, Node } from '@ace/contracts';

import { createNode } from '../../nodes/factory';
import { NODE_SLOT } from '../placement';
import {
  CLIPBOARD_MARKER,
  clearClipboard,
  copyNodes,
  parseClipboard,
  pasteNodes,
  readClipboard,
  writeClipboard,
} from './clipboard';

const A = 'wf_a';
const B = 'wf_b';

function link(from: Node, to: Node, id: string): Edge {
  return {
    id,
    workflowId: A,
    kind: 'data',
    from: { nodeId: from.id, portId: from.outputs[0]!.id },
    to: { nodeId: to.id, portId: to.inputs[0]!.id },
  };
}

describe('FR-CAN-013 copy/paste nodes between workflows', () => {
  const input = createNode('input', A, { x: 0, y: 0 });
  const agent = {
    ...createNode('agent', A, { x: 300, y: 0 }),
    name: 'Writer',
  } as Node;
  (agent.config as { instructions: string }).instructions = 'Write a haiku.';
  const output = createNode('output', A, { x: 600, y: 0 });
  const edges = [link(input, agent, 'e1'), link(agent, output, 'e2')];

  beforeEach(() => clearClipboard());

  it('copies the selected nodes and only the edges between them', () => {
    const payload = copyNodes(A, [input, agent, output], edges, [input.id, agent.id])!;
    expect(payload.marker).toBe(CLIPBOARD_MARKER);
    expect(payload.nodes.map((n) => n.id)).toEqual([input.id, agent.id]);
    expect(payload.edges.map((e) => e.id)).toEqual(['e1']);
    expect(copyNodes(A, [input], [], [])).toBeUndefined();
  });

  it('pastes into another workflow with new ids, the same kind/name/config, and rewired edges', () => {
    const payload = copyNodes(A, [input, agent, output], edges, [input.id, agent.id])!;
    const pasted = pasteNodes(payload, B, []);

    expect(pasted.nodes).toHaveLength(2);
    const [pIn, pAgent] = pasted.nodes as [Node, Node];
    expect(pIn.id).not.toBe(input.id);
    expect(pAgent.id).not.toBe(agent.id);
    expect(pAgent.workflowId).toBe(B);
    expect(pAgent.kind).toBe('agent');
    expect(pAgent.name).toBe('Writer');
    expect(pAgent.config).toEqual(agent.config);
    expect(pAgent.config).not.toBe(agent.config);
    // ports belong to the new node
    expect(pAgent.inputs.every((p) => p.id.startsWith(`${pAgent.id}:`))).toBe(true);

    expect(pasted.edges).toHaveLength(1);
    const [edge] = pasted.edges as [Edge];
    expect(edge.id).not.toBe('e1');
    expect(edge.workflowId).toBe(B);
    expect(edge.from).toEqual({ nodeId: pIn.id, portId: pIn.outputs[0]!.id });
    expect(edge.to).toEqual({ nodeId: pAgent.id, portId: pAgent.inputs[0]!.id });
  });

  it('pasting into the same workflow never lands a copy on top of an existing card', () => {
    const payload = copyNodes(A, [input, agent], edges, [input.id, agent.id])!;
    const pasted = pasteNodes(payload, A, [input, agent]);
    for (const copy of pasted.nodes) {
      for (const node of [input, agent, ...pasted.nodes.filter((n) => n !== copy)]) {
        const clash =
          Math.abs(copy.position.x - node.position.x) < NODE_SLOT.width &&
          Math.abs(copy.position.y - node.position.y) < NODE_SLOT.height;
        expect(clash).toBe(false);
      }
    }
  });

  it('keeps the copy in memory and offers it on the system clipboard as marked JSON', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const payload = copyNodes(A, [input], [], [input.id])!;
    writeClipboard(payload);
    expect(readClipboard()).toBe(payload);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(parseClipboard(writeText.mock.calls[0]![0] as string)).toEqual(payload);
  });

  it('ignores clipboard text that is not ACE nodes', () => {
    expect(parseClipboard('hello')).toBeUndefined();
    expect(parseClipboard('{"nodes":[]}')).toBeUndefined();
    expect(parseClipboard('null')).toBeUndefined();
  });
});
