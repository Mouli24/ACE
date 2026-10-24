import type { Edge, GraphOp, Node, WorkflowGraphResponse } from '@ace/contracts';
import { create } from 'zustand';

import { applyOps } from '../../workflows/apply-ops';

/** The part of a graph undo needs: what is on the Canvas right now. */
export interface GraphState {
  nodes: readonly Node[];
  edges: readonly Edge[];
}

/** One undoable user edit: the ops that made it and the ops that take it back. */
export interface HistoryEntry {
  label: string;
  do: GraphOp[];
  undo: GraphOp[];
}

/** FR-CAN-009 asks for at least 50 steps; twice that costs nothing. */
export const HISTORY_LIMIT = 100;

/** `applyOps` copies `workflow` through untouched, so the history never needs a real one. */
const NO_WORKFLOW = {} as WorkflowGraphResponse['workflow'];

/** The graph after one op, applied exactly as the optimistic cache applies it. */
function step(graph: GraphState, op: GraphOp): GraphState {
  const next = applyOps(
    { workflow: NO_WORKFLOW, nodes: [...graph.nodes], edges: [...graph.edges] },
    [op],
  );
  return { nodes: next.nodes, edges: next.edges };
}

/** The ops that undo one op, judged against the graph just before it ran. */
function inverseOf(graph: GraphState, op: GraphOp): GraphOp[] {
  switch (op.op) {
    case 'add_node':
      return [{ op: 'delete_node', nodeId: op.node.id }];

    case 'delete_node': {
      const node = graph.nodes.find((n) => n.id === op.nodeId);
      if (!node) return [];
      // the engine drops a deleted node's edges with it, so undo has to bring them back too
      const attached = graph.edges.filter(
        (e) => e.from.nodeId === op.nodeId || e.to.nodeId === op.nodeId,
      );
      return [
        { op: 'add_node', node: structuredClone(node) },
        ...attached.map((edge) => ({ op: 'add_edge' as const, edge: structuredClone(edge) })),
      ];
    }

    case 'move_node': {
      const node = graph.nodes.find((n) => n.id === op.nodeId);
      return node ? [{ op: 'move_node', nodeId: op.nodeId, position: { ...node.position } }] : [];
    }

    case 'update_node': {
      const node = graph.nodes.find((n) => n.id === op.nodeId);
      if (!node) return [];
      const patch: { name?: string; config?: Record<string, unknown> } = {};
      if (op.patch.name !== undefined) patch.name = node.name;
      if (op.patch.config !== undefined) {
        const before = node.config as Record<string, unknown>;
        patch.config = Object.fromEntries(
          Object.keys(op.patch.config)
            .filter((key) => key in before)
            .map((key) => [key, structuredClone(before[key])]),
        );
      }
      return [{ op: 'update_node', nodeId: op.nodeId, patch } as GraphOp];
    }

    case 'add_edge':
      return [{ op: 'delete_edge', edgeId: op.edge.id }];

    case 'update_edge': {
      const edge = graph.edges.find((e) => e.id === op.edgeId);
      if (edge === undefined) return [];
      // D405: undoing a debate change puts the debate back as it was, or off.
      const patch = {
        ...(op.patch.loop !== undefined && edge.loop ? { loop: edge.loop } : {}),
        ...(op.patch.debate !== undefined ? { debate: edge.debate ?? null } : {}),
      };
      return Object.keys(patch).length === 0
        ? []
        : [{ op: 'update_edge', edgeId: op.edgeId, patch }];
    }

    case 'delete_edge': {
      const edge = graph.edges.find((e) => e.id === op.edgeId);
      return edge ? [{ op: 'add_edge', edge: structuredClone(edge) }] : [];
    }
  }
}

/**
 * The ops that take `ops` back, derived from the graph as it was *before* they ran (FR-CAN-009).
 * Each op is inverted against the graph at its own moment, and the inverses run in reverse order,
 * so a batch that deletes edges and then their node comes back node first, edges after.
 */
export function inverseOps(before: GraphState, ops: readonly GraphOp[]): GraphOp[] {
  const groups: GraphOp[][] = [];
  let graph = before;
  for (const op of ops) {
    groups.push(inverseOf(graph, op));
    graph = step(graph, op);
  }
  return groups.reverse().flat();
}

/**
 * Whether `ops` still make sense on `graph`: every node or edge they touch is there, and nothing
 * they add is there already. A remote edit (another tab, an import) can make an old entry stale;
 * replaying it anyway would be refused by the engine or, worse, half-applied.
 */
export function canApply(graph: GraphState, ops: readonly GraphOp[]): boolean {
  let current = graph;
  for (const op of ops) {
    const hasNode = (id: string) => current.nodes.some((n) => n.id === id);
    const hasEdge = (id: string) => current.edges.some((e) => e.id === id);
    switch (op.op) {
      case 'add_node':
        if (hasNode(op.node.id)) return false;
        break;
      case 'update_node':
      case 'move_node':
      case 'delete_node':
        if (!hasNode(op.nodeId)) return false;
        break;
      case 'add_edge':
        if (hasEdge(op.edge.id) || !hasNode(op.edge.from.nodeId) || !hasNode(op.edge.to.nodeId)) {
          return false;
        }
        break;
      case 'update_edge':
      case 'delete_edge':
        if (!hasEdge(op.edgeId)) return false;
        break;
    }
    current = step(current, op);
  }
  return true;
}

/**
 * Whether `after` shows what `ops` were meant to leave behind, starting from `before`: each node and
 * edge they touch is present or absent as expected, and each node they place is where they put it.
 * Used once the sync settles, to notice an undo or redo the engine refused.
 */
export function reflects(before: GraphState, ops: readonly GraphOp[], after: GraphState): boolean {
  const expected = ops.reduce(step, before);
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const op of ops) {
    if (op.op === 'add_node') nodeIds.add(op.node.id);
    else if (op.op === 'add_edge') edgeIds.add(op.edge.id);
    else if ('nodeId' in op) nodeIds.add(op.nodeId);
    else edgeIds.add(op.edgeId);
  }
  for (const id of nodeIds) {
    const want = expected.nodes.find((n) => n.id === id);
    const got = after.nodes.find((n) => n.id === id);
    if (Boolean(want) !== Boolean(got)) return false;
    if (want && got && (want.position.x !== got.position.x || want.position.y !== got.position.y)) {
      return false;
    }
  }
  for (const id of edgeIds) {
    const want = expected.edges.some((e) => e.id === id);
    const got = after.edges.some((e) => e.id === id);
    if (want !== got) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- the stacks */

interface Stacks {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

interface HistoryState {
  byWorkflow: Record<string, Stacks>;
  /** A new edit: pushed on the undo stack, and the redo stack is cleared. */
  record(workflowId: string, entry: HistoryEntry): void;
  /** Take the newest undo entry and move it to the redo stack. */
  takeUndo(workflowId: string): HistoryEntry | undefined;
  /** Take the newest redo entry and move it back to the undo stack. */
  takeRedo(workflowId: string): HistoryEntry | undefined;
  /** Forget one entry wherever it is (the engine refused it, or it went stale). */
  discard(workflowId: string, entry: HistoryEntry): void;
  clear(workflowId?: string): void;
}

const EMPTY: Stacks = { past: [], future: [] };

/**
 * Undo/redo per workflow (FR-CAN-009). Client-side only — the engine never sees the stacks; what it
 * sees is the ops each step replays, through the same autosave as any other edit (BR-01).
 */
export const useHistoryStore = create<HistoryState>((set, get) => {
  const stacks = (workflowId: string) => get().byWorkflow[workflowId] ?? EMPTY;
  const put = (workflowId: string, next: Stacks) =>
    set((s) => ({ byWorkflow: { ...s.byWorkflow, [workflowId]: next } }));

  return {
    byWorkflow: {},
    record: (workflowId, entry) => {
      if (entry.do.length === 0) return;
      const { past } = stacks(workflowId);
      put(workflowId, { past: [...past, entry].slice(-HISTORY_LIMIT), future: [] });
    },
    takeUndo: (workflowId) => {
      const { past, future } = stacks(workflowId);
      const entry = past[past.length - 1];
      if (!entry) return undefined;
      put(workflowId, { past: past.slice(0, -1), future: [...future, entry] });
      return entry;
    },
    takeRedo: (workflowId) => {
      const { past, future } = stacks(workflowId);
      const entry = future[future.length - 1];
      if (!entry) return undefined;
      put(workflowId, { past: [...past, entry], future: future.slice(0, -1) });
      return entry;
    },
    discard: (workflowId, entry) => {
      const { past, future } = stacks(workflowId);
      put(workflowId, {
        past: past.filter((e) => e !== entry),
        future: future.filter((e) => e !== entry),
      });
    },
    clear: (workflowId) =>
      set((s) => {
        if (workflowId === undefined) return { byWorkflow: {} };
        const rest = { ...s.byWorkflow };
        delete rest[workflowId];
        return { byWorkflow: rest };
      }),
  };
});
