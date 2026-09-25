import type { Edge, Id } from '@ace/contracts';

/**
 * Reachability over a run snapshot, for the two controls that need it: "everything after this
 * node" (FR-ERR-004, retry with downstream) and "everything before it" (FR-EXE-013, Start from
 * node, D83).
 *
 * Only `data` edges are walked. A loop edge points backwards by construction (D73: its target is
 * strictly upstream of its source), so following it would make every node in a loop body both
 * upstream and downstream of every other — "everything after the Reviewer" would include the
 * Writer that feeds it, and a retry with downstream would re-run the loop from the inside.
 */

export function dataEdges(edges: readonly Edge[]): Edge[] {
  return edges.filter((edge) => edge.kind === 'data');
}

function reach(startNodeId: Id, edges: readonly Edge[], forward: boolean): Set<Id> {
  const links = dataEdges(edges);
  const reached = new Set<Id>();
  const queue: Id[] = [startNodeId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of links) {
      const from = forward ? edge.from.nodeId : edge.to.nodeId;
      const to = forward ? edge.to.nodeId : edge.from.nodeId;
      if (from !== current || reached.has(to)) continue;
      reached.add(to);
      queue.push(to);
    }
  }

  // A cycle could have walked back to where it started; "downstream of X" never includes X.
  reached.delete(startNodeId);
  return reached;
}

/** Every node reachable after this one along data edges (FR-ERR-004). */
export function downstreamOf(nodeId: Id, edges: readonly Edge[]): Set<Id> {
  return reach(nodeId, edges, true);
}

/** Every node that feeds this one, transitively, along data edges (FR-EXE-013, D83). */
export function upstreamOf(nodeId: Id, edges: readonly Edge[]): Set<Id> {
  return reach(nodeId, edges, false);
}
