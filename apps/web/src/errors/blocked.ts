import type { EdgeKind, Id } from '@ace/contracts';

/** Enough of an `Edge` to walk a graph backwards; the snapshot's edges satisfy it as they are. */
export interface UpstreamEdge {
  kind: EdgeKind;
  from: { nodeId: Id };
  to: { nodeId: Id };
}

/**
 * Which node's failure is the reason this one is BLOCKED (FR-ERR-006, TC-ERR-007).
 *
 * The engine says a node is BLOCKED; it does not say by what, so the card works it out from the
 * snapshot: walk upstream, breadth-first, and answer with the nearest node that failed or was
 * stopped. Loop edges are skipped — they point backwards by design (FR-CON-007), and following one
 * would answer with a node *downstream* of this one.
 *
 * Breadth-first in edge order, so two failures upstream always name the nearer one, and the same
 * graph always names the same node.
 */
export function findBlockingNodeId(
  nodeId: Id,
  edges: readonly UpstreamEdge[],
  stoppers: ReadonlySet<Id>,
): Id | undefined {
  const dataEdges = edges.filter((edge) => edge.kind !== 'loop');
  const seen = new Set<Id>([nodeId]);
  let frontier: Id[] = [nodeId];

  while (frontier.length > 0) {
    const next: Id[] = [];
    for (const current of frontier) {
      for (const edge of dataEdges) {
        if (edge.to.nodeId !== current) continue;
        const upstream = edge.from.nodeId;
        if (stoppers.has(upstream)) return upstream;
        if (seen.has(upstream)) continue;
        seen.add(upstream);
        next.push(upstream);
      }
    }
    frontier = next;
  }
  return undefined;
}
