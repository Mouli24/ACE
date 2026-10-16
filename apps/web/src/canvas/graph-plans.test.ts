import { derivePorts, type Edge, type GraphOp, type Node } from '@ace/contracts';

import { createNode } from '../nodes/factory';
import {
  FIRST_STAGE_AT,
  NEW_STAGE_NAME,
  movesBack,
  planNewStage,
  removeReconnectingOps,
  snapshotPositions,
  takeMoveBack,
} from './graph-plans';

const WF = '01WF00000000000000000000000';
let seq = 0;

function link(from: Node, to: Node, fromIndex = 0, toIndex = 0): Edge {
  seq += 1;
  return {
    id: `e${seq}`,
    workflowId: WF,
    kind: 'data',
    from: { nodeId: from.id, portId: from.outputs[fromIndex]!.id },
    to: { nodeId: to.id, portId: to.inputs[toIndex]!.id },
  };
}

const added = (ops: GraphOp[]) =>
  ops.flatMap((op) => (op.op === 'add_edge' ? [[op.edge.from.portId, op.edge.to.portId]] : []));

describe('D333 removeReconnectingOps', () => {
  it('deletes the node first, then joins each incoming edge to each outgoing one', () => {
    const input = createNode('input', WF, { x: 0, y: 0 });
    const agent = createNode('agent', WF, { x: 300, y: 0 });
    const output = createNode('output', WF, { x: 600, y: 0 });
    const ops = removeReconnectingOps(
      [input, agent, output],
      [link(input, agent), link(agent, output)],
      agent.id,
      WF,
    );
    expect(ops[0]).toEqual({ op: 'delete_node', nodeId: agent.id });
    expect(added(ops)).toEqual([[input.outputs[0]!.id, output.inputs[0]!.id]]);
  });

  it('every incoming × every outgoing, where a single input is free for one of them only', () => {
    // a, b → join (text, many in) → c, d (single text inputs)
    const a = createNode('input', WF, { x: 0, y: 0 });
    const b = createNode('input', WF, { x: 0, y: 200 });
    const transform = createNode('transform', WF, { x: 300, y: 0 });
    const asJoin = { ...transform, config: { op: 'join' } } as Node;
    const joined = { ...asJoin, ...derivePorts(asJoin) } as Node;
    const c = createNode('agent', WF, { x: 600, y: 0 });
    const d = createNode('agent', WF, { x: 600, y: 300 });
    const ops = removeReconnectingOps(
      [a, b, joined, c, d],
      [link(a, joined), link(b, joined), link(joined, c), link(joined, d)],
      joined.id,
      WF,
    );
    // a lands on both; b finds c and d already taken (single inputs)
    expect(added(ops)).toEqual([
      [a.outputs[0]!.id, c.inputs[0]!.id],
      [a.outputs[0]!.id, d.inputs[0]!.id],
    ]);
  });

  it('skips a reconnection the types forbid', () => {
    const retrieval = createNode('retrieval', WF, { x: 0, y: 0 });
    const template = createNode('transform', WF, { x: 300, y: 0 });
    const agent = createNode('agent', WF, { x: 600, y: 0 });
    // retrieval.out is json and agent.in is text: no edge, but the template still goes
    const ops = removeReconnectingOps(
      [retrieval, template, agent],
      [link(retrieval, template), link(template, agent)],
      template.id,
      WF,
    );
    expect(ops).toEqual([{ op: 'delete_node', nodeId: template.id }]);
  });

  it('is nothing for a node that is not there', () => {
    expect(removeReconnectingOps([], [], 'gone', WF)).toEqual([]);
  });
});

const CHOICE = { providerId: 'p1', modelId: 'm-1' };

describe('D332 planNewStage (Add node)', () => {
  it('on an empty board: a "New agent" at (440, 150), nothing to link', () => {
    const plan = planNewStage({ nodes: [], edges: [], workflowId: WF, choice: CHOICE });
    expect(plan.node.kind).toBe('agent');
    expect(plan.node.name).toBe(NEW_STAGE_NAME);
    expect(plan.node.position).toEqual(FIRST_STAGE_AT);
    expect(plan.ops).toEqual([{ op: 'add_node', node: plan.node }]);
  });

  it('after the last stage: +320 x, ±50 y alternating, linked from its first output', () => {
    const one = createNode('agent', WF, { x: 440, y: 150 });
    let plan = planNewStage({ nodes: [one], edges: [], workflowId: WF, choice: CHOICE });
    expect(plan.node.position).toEqual({ x: 760, y: 100 });
    const edge = plan.ops.find((op) => op.op === 'add_edge');
    expect(edge).toMatchObject({
      edge: {
        kind: 'data',
        from: { nodeId: one.id, portId: one.outputs[0]!.id },
        to: { nodeId: plan.node.id, portId: plan.node.inputs[0]!.id },
      },
    });

    const two = createNode('model', WF, { x: 760, y: 100 });
    plan = planNewStage({
      nodes: [one, two],
      edges: [],
      workflowId: WF,
      choice: CHOICE,
    });
    expect(plan.node.position).toEqual({ x: 1080, y: 150 });
  });

  // D351 supersedes D332's "first CONNECTED provider" default: the plan takes only what the
  // person chose in the provider-first picker (PG-1.3).
  it('PG-1.3 the new agent is on the chosen provider and model, never a default one', () => {
    const plan = planNewStage({
      nodes: [],
      edges: [],
      workflowId: WF,
      choice: { providerId: 'p1', modelId: 'here' },
    });
    expect(plan.node.kind === 'agent' && plan.node.config.providerId).toBe('p1');
    expect(plan.node.kind === 'agent' && plan.node.config.modelId).toBe('here');
  });
});

describe('D332 the position history behind undo-move', () => {
  const a = createNode('agent', WF, { x: 0, y: 0 });
  const b = createNode('agent', WF, { x: 300, y: 0 });

  it('a snapshot copies every position; moving back is one move per node that moved', () => {
    const snapshot = snapshotPositions([a, b]);
    const moved = [{ ...a, position: { x: 50, y: 60 } } as Node, b];
    expect(movesBack(snapshot, moved)).toEqual([
      { op: 'move_node', nodeId: a.id, position: { x: 0, y: 0 } },
    ]);
    expect(movesBack(snapshot, [a, b])).toEqual([]);
  });

  it('undo takes the latest snapshot that moves something, dropping no-op presses on the way', () => {
    const start = snapshotPositions([a, b]);
    const moved = [{ ...a, position: { x: 50, y: 60 } } as Node, b];
    const pressWithoutDrag = snapshotPositions(moved);
    const { ops, rest } = takeMoveBack([start, pressWithoutDrag], moved);
    expect(ops).toEqual([{ op: 'move_node', nodeId: a.id, position: { x: 0, y: 0 } }]);
    expect(rest).toEqual([]);
    expect(takeMoveBack([pressWithoutDrag], moved)).toEqual({ ops: [], rest: [] });
  });
});
