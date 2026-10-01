import type { Edge, Position } from '@ace/contracts';

import { NODE_SLOT } from '../placement';

/** A node as the layout sees it: where it is, and how big React Flow measured it (if it has). */
export interface LayoutNode {
  id: string;
  position: Position;
  width?: number;
  height?: number;
}

/** Space between two columns and between two cards in a column. */
export const LAYOUT_GAP = { column: 80, row: 40 } as const;

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * FR-CAN-008 / ADR-010: a left-to-right layered layout.
 *
 * 1. Layering runs on `data` edges only — a loop edge points back on purpose (FR-CON-007) and would
 *    otherwise drag its target to the far right. A data cycle cannot exist (FR-CON-003), but if one
 *    arrives anyway its back edges are dropped by a depth-first walk so the layout still ends.
 * 2. Each node's column is its longest path from a source, so every data edge points right.
 * 3. Inside a column, nodes are ordered by the mean row of their parents, then by their current
 *    `y`, then by id — deterministic for the same graph whatever order it arrives in.
 * 4. Columns are as wide as their widest card and cards stack with a gap, using the measured size
 *    when React Flow has one and `NODE_SLOT` when it does not: no two boxes can overlap.
 *
 * The result is anchored at the current top-left of the graph so the view does not jump away.
 * Pure: returns the new position of every node, rounded to whole pixels.
 */
export function autoLayout(
  nodes: readonly LayoutNode[],
  edges: readonly Edge[],
): Map<string, Position> {
  const result = new Map<string, Position>();
  if (nodes.length === 0) return result;

  const sorted = [...nodes].sort((a, b) => byId(a.id, b.id));
  const ids = new Set(sorted.map((n) => n.id));
  const size = (n: LayoutNode) => ({
    width: n.width ?? NODE_SLOT.width,
    height: n.height ?? NODE_SLOT.height,
  });

  // data edges between known nodes, deduplicated and in a stable order
  const out = new Map<string, string[]>(sorted.map((n) => [n.id, []]));
  const dataEdges = edges
    .filter((e) => e.kind !== 'loop' && ids.has(e.from.nodeId) && ids.has(e.to.nodeId))
    .filter((e) => e.from.nodeId !== e.to.nodeId)
    .sort((a, b) => byId(a.from.nodeId, b.from.nodeId) || byId(a.to.nodeId, b.to.nodeId));
  for (const e of dataEdges) {
    const list = out.get(e.from.nodeId)!;
    if (!list.includes(e.to.nodeId)) list.push(e.to.nodeId);
  }

  // drop back edges (only possible on a malformed graph) so what remains is acyclic
  const state = new Map<string, 'open' | 'done'>();
  const forward = new Map<string, string[]>(sorted.map((n) => [n.id, []]));
  const visit = (start: string) => {
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    state.set(start, 'open');
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const children = out.get(top.id)!;
      if (top.next >= children.length) {
        state.set(top.id, 'done');
        stack.pop();
        continue;
      }
      const child = children[top.next]!;
      top.next += 1;
      const seen = state.get(child);
      if (seen === 'open') continue; // back edge
      forward.get(top.id)!.push(child);
      if (seen === undefined) {
        state.set(child, 'open');
        stack.push({ id: child, next: 0 });
      }
    }
  };
  for (const n of sorted) if (!state.has(n.id)) visit(n.id);

  // longest-path layering over a topological order (Kahn)
  const indegree = new Map<string, number>(sorted.map((n) => [n.id, 0]));
  const parents = new Map<string, string[]>(sorted.map((n) => [n.id, []]));
  for (const [from, tos] of forward) {
    for (const to of tos) {
      indegree.set(to, indegree.get(to)! + 1);
      parents.get(to)!.push(from);
    }
  }
  const layer = new Map<string, number>();
  const ready = sorted.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    layer.set(id, Math.max(0, ...parents.get(id)!.map((p) => layer.get(p)! + 1)));
    for (const to of forward.get(id)!) {
      indegree.set(to, indegree.get(to)! - 1);
      if (indegree.get(to) === 0) ready.push(to);
    }
  }

  const columns: string[][] = [];
  for (const id of order) {
    const index = layer.get(id)!;
    (columns[index] ??= []).push(id);
  }

  const node = new Map(sorted.map((n) => [n.id, n]));
  const row = new Map<string, number>();
  for (const column of columns) {
    const key = (id: string) => {
      const ps = parents.get(id)!;
      return ps.length === 0
        ? Number.POSITIVE_INFINITY
        : ps.reduce((sum, p) => sum + row.get(p)!, 0) / ps.length;
    };
    column.sort(
      (a, b) => key(a) - key(b) || node.get(a)!.position.y - node.get(b)!.position.y || byId(a, b),
    );
    column.forEach((id, i) => row.set(id, i));
  }

  const originX = Math.round(Math.min(...sorted.map((n) => n.position.x)));
  const originY = Math.round(Math.min(...sorted.map((n) => n.position.y)));
  let x = originX;
  for (const column of columns) {
    let y = originY;
    let widest = 0;
    for (const id of column) {
      const { width, height } = size(node.get(id)!);
      result.set(id, { x: Math.round(x), y: Math.round(y) });
      y += height + LAYOUT_GAP.row;
      widest = Math.max(widest, width);
    }
    x += widest + LAYOUT_GAP.column;
  }
  return result;
}
