import type { Edge, Id } from '@ace/contracts';

/**
 * Cycle detection over the graph (FR-CON-003, BR-05).
 *
 * Only `kind: 'data'` edges are walked. A loop edge is how a cycle is *allowed* to exist
 * (round 3), so counting one here would refuse the very thing that makes loops legal.
 */
export function findCycle(edges: readonly Edge[]): Id[] | null {
  const adjacency = new Map<Id, Id[]>();
  for (const edge of edges) {
    if (edge.kind !== 'data') continue;
    const from = adjacency.get(edge.from.nodeId) ?? [];
    from.push(edge.to.nodeId);
    adjacency.set(edge.from.nodeId, from);
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<Id, number>();
  const stack: Id[] = [];

  /** Iterative DFS: a 200-node workflow is well within recursion limits, but a run is not. */
  function visit(start: Id): Id[] | null {
    const work: { node: Id; next: number }[] = [{ node: start, next: 0 }];
    colour.set(start, GREY);
    stack.push(start);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const neighbours = adjacency.get(frame.node) ?? [];

      if (frame.next >= neighbours.length) {
        colour.set(frame.node, BLACK);
        stack.pop();
        work.pop();
        continue;
      }

      const neighbour = neighbours[frame.next]!;
      frame.next += 1;

      const seen = colour.get(neighbour) ?? WHITE;
      if (seen === GREY) {
        // Back edge: everything from the neighbour onwards on the stack is the cycle.
        const from = stack.indexOf(neighbour);
        return [...stack.slice(from), neighbour];
      }
      if (seen === BLACK) continue;

      colour.set(neighbour, GREY);
      stack.push(neighbour);
      work.push({ node: neighbour, next: 0 });
    }

    return null;
  }

  for (const node of adjacency.keys()) {
    if ((colour.get(node) ?? WHITE) !== WHITE) continue;
    const cycle = visit(node);
    if (cycle !== null) return cycle;
  }

  return null;
}

export function hasCycle(edges: readonly Edge[]): boolean {
  return findCycle(edges) !== null;
}
