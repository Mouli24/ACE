import { isDependencyEdge, type Edge, type Id } from '@ace/contracts';

/**
 * Reachability over a run snapshot, for the two controls that need it: "everything after this
 * node" (FR-ERR-004, retry with downstream) and "everything before it" (FR-EXE-013, Start from
 * node, D83).
 *
 * Data and order edges are walked (D373: a node that runs after another depends on it the way a
 * data edge's target does, so it is downstream of it). A loop edge points backwards by construction (D73: its target is
 * strictly upstream of its source), so following it would make every node in a loop body both
 * upstream and downstream of every other — "everything after the Reviewer" would include the
 * Writer that feeds it, and a retry with downstream would re-run the loop from the inside.
 */

export function dataEdges(edges: readonly Edge[]): Edge[] {
  return edges.filter((edge) => edge.kind === 'data');
}

/** Data and order edges: the ones a node waits on (D373). Loop edges never are (D73). */
export function dependencyEdges(edges: readonly Edge[]): Edge[] {
  return edges.filter(isDependencyEdge);
}

function reach(startNodeId: Id, edges: readonly Edge[], forward: boolean): Set<Id> {
  const links = dependencyEdges(edges);
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

/** Every node reachable after this one along data and order edges (FR-ERR-004, D373). */
export function downstreamOf(nodeId: Id, edges: readonly Edge[]): Set<Id> {
  return reach(nodeId, edges, true);
}

/** Every node this one waits on, transitively, along data and order edges (FR-EXE-013, D83, D373). */
export function upstreamOf(nodeId: Id, edges: readonly Edge[]): Set<Id> {
  return reach(nodeId, edges, false);
}
