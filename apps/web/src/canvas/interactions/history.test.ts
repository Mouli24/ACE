import type { Edge, GraphOp, Node, WorkflowGraphResponse } from '@ace/contracts';

import { createNode } from '../../nodes/factory';
import { applyOps } from '../../workflows/apply-ops';
import { createGraphEditor, type SyncLike } from './graph-editor';
import {
  HISTORY_LIMIT,
  canApply,
  inverseOps,
  reflects,
  useHistoryStore,
  type GraphState,
} from './history';

const W = 'wf_1';

function graphOf(nodes: Node[], edges: Edge[] = []): GraphState {
  return { nodes, edges };
}

function link(from: Node, to: Node, id = `e_${from.id}_${to.id}`): Edge {
  return {
    id,
    workflowId: W,
    kind: 'data',
    from: { nodeId: from.id, portId: from.outputs[0]!.id },
    to: { nodeId: to.id, portId: to.inputs[0]!.id },
  };
}

const run = (graph: GraphState, ops: readonly GraphOp[]): GraphState => {
  const next = applyOps(
    {
      workflow: {} as WorkflowGraphResponse['workflow'],
      nodes: [...graph.nodes],
      edges: [...graph.edges],
    },
    ops,
  );
  return { nodes: next.nodes, edges: next.edges };
};

/** Doing `ops` and then their inverse lands back on the starting graph. */
function roundTrips(before: GraphState, ops: GraphOp[]) {
  const after = run(before, ops);
  const back = run(after, inverseOps(before, ops));
  const norm = (g: GraphState) => ({
    nodes: [...g.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...g.edges].sort((a, b) => a.id.localeCompare(b.id)),
  });
  expect(norm(back)).toEqual(norm(before));
}

describe('FR-CAN-009 inverse ops', () => {
  const input = createNode('input', W, { x: 0, y: 0 });
  const agent = createNode('agent', W, { x: 300, y: 0 });
  const output = createNode('output', W, { x: 600, y: 0 });
  const e1 = link(input, agent);
  const e2 = link(agent, output);
  const base = graphOf([input, agent, output], [e1, e2]);

  it('add_node ↔ delete_node', () => {
    const extra = createNode('model', W, { x: 10, y: 10 });
    expect(inverseOps(base, [{ op: 'add_node', node: extra }])).toEqual([
      { op: 'delete_node', nodeId: extra.id },
    ]);
    roundTrips(base, [{ op: 'add_node', node: extra }]);
  });

  it('delete_node brings back the full node, config included, and the edges deleted with it', () => {
    const inverse = inverseOps(base, [{ op: 'delete_node', nodeId: agent.id }]);
    expect(inverse[0]).toEqual({ op: 'add_node', node: agent });
    expect(inverse.slice(1)).toEqual([
      { op: 'add_edge', edge: e1 },
      { op: 'add_edge', edge: e2 },
    ]);
    roundTrips(base, [{ op: 'delete_node', nodeId: agent.id }]);
  });

  it('move_node ↔ move_node to the old position', () => {
    const ops: GraphOp[] = [{ op: 'move_node', nodeId: agent.id, position: { x: 999, y: 9 } }];
    expect(inverseOps(base, ops)).toEqual([
      { op: 'move_node', nodeId: agent.id, position: { x: 300, y: 0 } },
    ]);
    roundTrips(base, ops);
  });

  it('add_edge ↔ delete_edge and delete_edge ↔ add_edge', () => {
    const extra = link(input, output, 'e_new');
    roundTrips(base, [{ op: 'add_edge', edge: extra }]);
    expect(inverseOps(base, [{ op: 'delete_edge', edgeId: e1.id }])).toEqual([
      { op: 'add_edge', edge: e1 },
    ]);
    roundTrips(base, [{ op: 'delete_edge', edgeId: e1.id }]);
  });

  it('update_node ↔ update_node with the old name and the old values of the patched keys', () => {
    const ops: GraphOp[] = [
      {
        op: 'update_node',
        nodeId: agent.id,
        patch: { name: 'Renamed', config: { instructions: 'x' } },
      },
    ];
    const inverse = inverseOps(base, ops);
    expect(inverse).toEqual([
      {
        op: 'update_node',
        nodeId: agent.id,
        patch: {
          name: agent.name,
          config: { instructions: (agent.config as { instructions: string }).instructions },
        },
      },
    ]);
    roundTrips(base, ops);
  });

  it('a batch (delete edges, then their node) is undone in reverse order', () => {
    const ops: GraphOp[] = [
      { op: 'delete_edge', edgeId: e1.id },
      { op: 'delete_edge', edgeId: e2.id },
      { op: 'delete_node', nodeId: agent.id },
    ];
    const inverse = inverseOps(base, ops);
    expect(inverse[0]).toEqual({ op: 'add_node', node: agent });
    roundTrips(base, ops);
  });

  it('canApply refuses ops whose node is gone or whose added id already exists', () => {
    expect(canApply(base, [{ op: 'move_node', nodeId: 'gone', position: { x: 0, y: 0 } }])).toBe(
      false,
    );
    expect(canApply(base, [{ op: 'add_node', node: agent }])).toBe(false);
    expect(
      canApply(base, [
        { op: 'add_edge', edge: link(input, createNode('output', W, { x: 0, y: 0 })) },
      ]),
    ).toBe(false);
    expect(canApply(base, [{ op: 'delete_edge', edgeId: e1.id }])).toBe(true);
    expect(canApply(base, [{ op: 'delete_edge', edgeId: 'nope' }])).toBe(false);
  });

  it('reflects tells a saved step from a refused one', () => {
    const ops: GraphOp[] = [{ op: 'move_node', nodeId: agent.id, position: { x: 5, y: 5 } }];
    expect(reflects(base, ops, run(base, ops))).toBe(true);
    expect(reflects(base, ops, base)).toBe(false);
  });
});

/* ------------------------------------------------------------------ the editor over a fake sync */

function harness(initial: GraphState) {
  let graph = initial;
  const notes: string[] = [];
  const sent: GraphOp[][] = [];
  let refuseNext = false;
  const sync: SyncLike = {
    enqueue: (ops) => {
      sent.push([...ops]);
      const before = graph;
      graph = run(graph, ops);
      if (refuseNext) {
        refuseNext = false;
        graph = before; // the engine refused: the cache is rewritten to the server's graph
      }
    },
    whenIdle: () => Promise.resolve(),
  };
  const editor = createGraphEditor({
    workflowId: W,
    sync,
    read: () => graph,
    notify: (m) => notes.push(m),
  });
  return {
    editor,
    notes,
    sent,
    get graph() {
      return graph;
    },
    set graph(next: GraphState) {
      graph = next;
    },
    refuse: () => {
      refuseNext = true;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('TC-CAN-008 undo/redo through graph-ops (FR-CAN-009)', () => {
  beforeEach(() => useHistoryStore.getState().clear());

  it('add, move, connect → undo ×3 → redo ×3 restores each state in order', async () => {
    const input = createNode('input', W, { x: 0, y: 0 });
    const h = harness(graphOf([input]));
    const states: GraphState[] = [h.graph];

    const agent = createNode('agent', W, { x: 300, y: 0 });
    h.editor.edit([{ op: 'add_node', node: agent }], 'Add node');
    states.push(h.graph);
    h.editor.edit([{ op: 'move_node', nodeId: agent.id, position: { x: 400, y: 80 } }], 'Move');
    states.push(h.graph);
    h.editor.edit([{ op: 'add_edge', edge: link(input, agent) }], 'Connect');
    states.push(h.graph);

    for (let i = 3; i >= 1; i -= 1) {
      h.editor.undo();
      await flush();
      expect(h.graph).toEqual(states[i - 1]);
    }
    for (let i = 1; i <= 3; i += 1) {
      h.editor.redo();
      await flush();
      expect(h.graph).toEqual(states[i]);
    }
    expect(h.notes).toEqual([]);
    // every step went through the sync as graph-ops: 3 edits + 3 undos + 3 redos
    expect(h.sent).toHaveLength(9);
  });

  it(`keeps at least 50 steps (cap ${HISTORY_LIMIT}), dropping the oldest beyond it`, () => {
    const node = createNode('agent', W, { x: 0, y: 0 });
    const h = harness(graphOf([node]));
    for (let i = 1; i <= HISTORY_LIMIT + 20; i += 1) {
      h.editor.edit([{ op: 'move_node', nodeId: node.id, position: { x: i, y: 0 } }], `Move ${i}`);
    }
    const past = useHistoryStore.getState().byWorkflow[W]!.past;
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(50);
    expect(past).toHaveLength(HISTORY_LIMIT);
    expect(past[0]!.label).toBe('Move 21');
    for (let i = 0; i < HISTORY_LIMIT; i += 1) h.editor.undo();
    expect(h.graph.nodes[0]!.position).toEqual({ x: 20, y: 0 });
  });

  it('a new edit clears the redo stack', () => {
    const node = createNode('agent', W, { x: 0, y: 0 });
    const h = harness(graphOf([node]));
    h.editor.edit([{ op: 'move_node', nodeId: node.id, position: { x: 1, y: 1 } }], 'a');
    h.editor.undo();
    h.editor.edit([{ op: 'move_node', nodeId: node.id, position: { x: 2, y: 2 } }], 'b');
    expect(useHistoryStore.getState().byWorkflow[W]!.future).toHaveLength(0);
    h.editor.redo();
    expect(h.graph.nodes[0]!.position).toEqual({ x: 2, y: 2 });
  });

  it('skips and drops a step a remote change made inapplicable, and says so', () => {
    const node = createNode('agent', W, { x: 0, y: 0 });
    const h = harness(graphOf([node]));
    h.editor.edit([{ op: 'move_node', nodeId: node.id, position: { x: 5, y: 5 } }], 'Move');
    h.graph = graphOf([]); // someone else deleted the node
    const sentBefore = h.sent.length;
    h.editor.undo();
    expect(h.sent).toHaveLength(sentBefore);
    expect(h.notes[0]).toMatch(/Undo skipped/);
    expect(useHistoryStore.getState().byWorkflow[W]).toEqual({ past: [], future: [] });
  });

  it('drops a step the engine refused once autosave settles, and says so', async () => {
    const node = createNode('agent', W, { x: 0, y: 0 });
    const h = harness(graphOf([node]));
    h.editor.edit([{ op: 'move_node', nodeId: node.id, position: { x: 5, y: 5 } }], 'Move');
    h.refuse();
    h.editor.undo();
    await flush();
    expect(h.notes[0]).toMatch(/not saved/);
    expect(useHistoryStore.getState().byWorkflow[W]).toEqual({ past: [], future: [] });
  });

  it('keeps one history per workflow', () => {
    const a = createNode('agent', W, { x: 0, y: 0 });
    const h = harness(graphOf([a]));
    h.editor.edit([{ op: 'move_node', nodeId: a.id, position: { x: 1, y: 1 } }], 'a');
    expect(useHistoryStore.getState().byWorkflow.other).toBeUndefined();
    expect(useHistoryStore.getState().takeUndo('other')).toBeUndefined();
    expect(useHistoryStore.getState().takeRedo('other')).toBeUndefined();
    useHistoryStore.getState().clear(W);
    expect(useHistoryStore.getState().byWorkflow[W]).toBeUndefined();
  });
});
