import {
  derivePorts,
  portId,
  type Edge,
  type Node,
  type WorkflowGraphResponse,
} from '@ace/contracts';

import { applyOps } from './apply-ops';

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const A = '01ARZ3NDEKTSV4RRFFQ69G5FA0';
const B = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const E1 = '01ARZ3NDEKTSV4RRFFQ69G5FE1';
const NOW = '2026-09-22T00:00:00.000Z';

function inputNode(id: string): Node {
  const base = {
    id,
    kind: 'input' as const,
    config: { artifactIds: [], outputTypes: ['text' as const] },
  };
  return { ...base, workflowId: WF, name: 'In', position: { x: 0, y: 0 }, ...derivePorts(base) };
}

function agentNode(id: string): Node {
  const base = {
    id,
    kind: 'agent' as const,
    config: {
      routing: { policy: 'fixed' as const, fallbackModelIds: [] },
      instructions: '',
      inputTypes: ['text' as const],
      outputTypes: ['text' as const],
      execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
      contextPolicy: { budgetTokens: 4000 },
      tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
      knowledgeBaseIds: [],
      memory: { enabled: false },
      skillIds: [],
    },
  };
  return {
    ...base,
    workflowId: WF,
    name: 'Agent',
    position: { x: 200, y: 0 },
    ...derivePorts(base),
  };
}

const edge: Edge = {
  id: E1,
  workflowId: WF,
  kind: 'data',
  from: { nodeId: A, portId: portId(A, 'out', 'text') },
  to: { nodeId: B, portId: portId(B, 'in', 'text') },
};

function graph(): WorkflowGraphResponse {
  return {
    workflow: {
      id: WF,
      projectId: A,
      name: 'F',
      version: 3,
      formatVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
    nodes: [inputNode(A), agentNode(B)],
    edges: [edge],
  };
}

describe('applyOps — local mirror of the §2.6 graph operations (FR-WF-004 optimistic UI)', () => {
  it('does not mutate its input', () => {
    const g = graph();
    const snapshot = JSON.stringify(g);
    applyOps(g, [{ op: 'delete_node', nodeId: A }]);
    expect(JSON.stringify(g)).toBe(snapshot);
  });

  it('add_node appends the node', () => {
    const next = applyOps(graph(), [
      { op: 'add_node', node: inputNode('01ARZ3NDEKTSV4RRFFQ69G5FA2') },
    ]);
    expect(next.nodes).toHaveLength(3);
  });

  it('move_node changes only the position', () => {
    const next = applyOps(graph(), [{ op: 'move_node', nodeId: A, position: { x: 9, y: 8 } }]);
    expect(next.nodes[0]?.position).toEqual({ x: 9, y: 8 });
    expect(next.nodes[0]?.name).toBe('In');
  });

  it('update_node merges name and config shallowly and re-derives ports', () => {
    const next = applyOps(graph(), [
      {
        op: 'update_node',
        nodeId: B,
        patch: { name: 'Writer', config: { outputTypes: ['text', 'image'] } },
      },
    ]);
    const agent = next.nodes.find((n) => n.id === B);
    expect(agent?.name).toBe('Writer');
    expect(agent?.kind === 'agent' && agent.config.instructions).toBe('');
    expect(agent?.outputs.map((p) => p.dataType)).toEqual(['text', 'image']);
  });

  it('delete_node removes the node and every edge touching it (FR-CAN-005)', () => {
    const next = applyOps(graph(), [{ op: 'delete_node', nodeId: A }]);
    expect(next.nodes.map((n) => n.id)).toEqual([B]);
    expect(next.edges).toEqual([]);
  });

  it('add_edge, update_edge and delete_edge', () => {
    const e2: Edge = { ...edge, id: '01ARZ3NDEKTSV4RRFFQ69G5FE2' };
    let next = applyOps(graph(), [{ op: 'add_edge', edge: e2 }]);
    expect(next.edges).toHaveLength(2);
    const loop = {
      maxIterations: 3,
      exitCondition: { path: 'done', equals: true },
      onMax: 'fail' as const,
    };
    next = applyOps(next, [{ op: 'update_edge', edgeId: e2.id, patch: { loop } }]);
    expect(next.edges[1]?.loop).toEqual(loop);
    next = applyOps(next, [{ op: 'delete_edge', edgeId: E1 }]);
    expect(next.edges.map((e) => e.id)).toEqual([e2.id]);
  });

  it('leaves the version untouched (the engine owns it, BR-01)', () => {
    const next = applyOps(graph(), [{ op: 'move_node', nodeId: A, position: { x: 1, y: 1 } }]);
    expect(next.workflow.version).toBe(3);
  });

  it('ignores ops on unknown ids instead of throwing', () => {
    const next = applyOps(graph(), [
      { op: 'move_node', nodeId: '01ARZ3NDEKTSV4RRFFQ69G5FZZ', position: { x: 1, y: 1 } },
      { op: 'delete_edge', edgeId: '01ARZ3NDEKTSV4RRFFQ69G5FZZ' },
    ]);
    expect(next.nodes).toHaveLength(2);
    expect(next.edges).toHaveLength(1);
  });
});
