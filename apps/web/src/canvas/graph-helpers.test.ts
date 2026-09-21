import { derivePorts, portId, type Edge, type Node } from '@ace/contracts';

import { createNode } from '../nodes/factory';
import { checkConnection } from './connect';
import { duplicateNodes } from './duplicate';
import { toFlowEdges, toFlowNodes } from './to-flow';

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function edge(from: Node, fromPort: string, to: Node, toPort: string): Edge {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FE1',
    workflowId: WF,
    kind: 'data',
    from: { nodeId: from.id, portId: portId(from.id, 'out', fromPort) },
    to: { nodeId: to.id, portId: portId(to.id, 'in', toPort) },
  };
}

describe('checkConnection (FR-CON-002/003/005 on the client)', () => {
  const input = createNode('input', WF, { x: 0, y: 0 });
  const agent = createNode('agent', WF, { x: 0, y: 0 });
  const other = createNode('input', WF, { x: 0, y: 0 });
  const nodes = [input, agent, other];

  it('allows a matching type into a free input', () => {
    const result = checkConnection(nodes, [], {
      source: input.id,
      sourceHandle: portId(input.id, 'out', 'text'),
      target: agent.id,
      targetHandle: portId(agent.id, 'in', 'text'),
    });
    expect(result.ok).toBe(true);
  });

  it('TC-CON-002: refuses text → image-only input with the contract reason', () => {
    const imgAgent = {
      ...agent,
      config: { ...agent.config, inputTypes: ['image'] as const },
    } as Node;
    const withPorts = { ...imgAgent, ...derivePorts(imgAgent) } as Node;
    const result = checkConnection([input, withPorts], [], {
      source: input.id,
      sourceHandle: portId(input.id, 'out', 'text'),
      target: withPorts.id,
      targetHandle: portId(withPorts.id, 'in', 'image'),
    });
    expect(result).toMatchObject({ ok: false, code: 'incompatible_types' });
    expect(!result.ok && result.reason).toMatch(/image/);
  });

  it('TC-CON-006: refuses a second edge into a single input', () => {
    const existing = edge(input, 'text', agent, 'text');
    const result = checkConnection(nodes, [existing], {
      source: other.id,
      sourceHandle: portId(other.id, 'out', 'text'),
      target: agent.id,
      targetHandle: portId(agent.id, 'in', 'text'),
    });
    expect(result).toMatchObject({ ok: false, code: 'single_input_occupied' });
  });

  it('TC-CON-003: refuses a plain edge that closes a cycle', () => {
    const a = createNode('agent', WF, { x: 0, y: 0 });
    const b = createNode('agent', WF, { x: 0, y: 0 });
    const ab = edge(a, 'text', b, 'text');
    const result = checkConnection([a, b], [ab], {
      source: b.id,
      sourceHandle: portId(b.id, 'out', 'text'),
      target: a.id,
      targetHandle: portId(a.id, 'in', 'text'),
    });
    expect(result).toMatchObject({ ok: false, code: 'cycle' });
    expect(!result.ok && result.reason).toMatch(/cycle/i);
  });

  it('refuses unknown ports', () => {
    const result = checkConnection(nodes, [], {
      source: input.id,
      sourceHandle: 'nope',
      target: agent.id,
      targetHandle: portId(agent.id, 'in', 'text'),
    });
    expect(result.ok).toBe(false);
  });
});

describe('duplicateNodes (FR-CAN-006)', () => {
  it('copies config with new ids, offset positions and re-derived ports', () => {
    const agent = createNode('agent', WF, { x: 100, y: 100 });
    const configured = {
      ...agent,
      name: 'Writer',
      config: { ...agent.config, instructions: 'hi' },
    } as Node;
    const [copy] = duplicateNodes([configured]);
    expect(copy).toBeDefined();
    expect(copy?.id).not.toBe(configured.id);
    expect(copy?.name).toBe('Writer');
    expect(copy?.kind === 'agent' && copy.config.instructions).toBe('hi');
    expect(copy?.position).toEqual({ x: 140, y: 140 });
    expect(copy?.outputs[0]?.id.startsWith(copy?.id ?? '!')).toBe(true);
    // editing the copy must not touch the original: no shared references
    expect(copy?.config).not.toBe(configured.config);
  });
});

describe('toFlowNodes / toFlowEdges', () => {
  it('maps contract nodes and edges to React Flow shapes and marks connected ports', () => {
    const input = createNode('input', WF, { x: 1, y: 2 });
    const agent = createNode('agent', WF, { x: 3, y: 4 });
    const e = edge(input, 'text', agent, 'text');
    const noop = () => undefined;
    const nodes = toFlowNodes([input, agent], [e], undefined, noop);
    expect(nodes.map((n) => n.id)).toEqual([input.id, agent.id]);
    expect(nodes[0]?.type).toBe('ace');
    expect(nodes[0]?.position).toEqual({ x: 1, y: 2 });
    expect(nodes[0]?.data.connectedPortIds.has(e.from.portId)).toBe(true);
    expect(nodes[1]?.data.connectedPortIds.has(e.to.portId)).toBe(true);
    const edges = toFlowEdges([e], [input, agent]);
    expect(edges[0]).toMatchObject({
      id: e.id,
      source: input.id,
      sourceHandle: e.from.portId,
      target: agent.id,
      targetHandle: e.to.portId,
      type: 'typed',
      data: { dataType: 'text', kind: 'data' },
    });
  });
});
