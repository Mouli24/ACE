import type { Edge, Id, Node } from '@ace/contracts';

import type { SinceRun } from '../nodes/NodeCard';

/**
 * PG-4.4: while a run is live, the Canvas draws what the run executes — its snapshot (BR-04) —
 * laid over the graph being edited. A node the run still has but the graph lost is a ghost card; a
 * node edited since the run froze it says so; an edge the run still walks but the graph lost is
 * drawn faint. Nothing here edits anything: ghosts are drawn, never saved.
 */
export interface RunSnapshotOverlay {
  /** Every node to draw: the live graph's, then the snapshot's ghosts. */
  nodes: Node[];
  /** Every edge to draw: the live graph's, then the snapshot's edges the graph lost. */
  edges: Edge[];
  /** How each node differs from the snapshot; absent when it is the same. */
  sinceRun: ReadonlyMap<Id, SinceRun>;
  /** The edges drawn only because the snapshot has them. */
  ghostEdgeIds: ReadonlySet<Id>;
}

/** The class a ghost edge carries, so the edge layer can draw it faint. */
export const GHOST_EDGE_CLASS = 'ace-ghost-edge';

/** JSON with object keys sorted, so two equal configs compare equal whatever their key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, each]) => each !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, each]) => `${JSON.stringify(key)}:${stable(each)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** What a run executes of a node: its config and its ports. Name and position do not change that. */
const executed = (node: Node): string =>
  stable({ kind: node.kind, config: node.config, inputs: node.inputs, outputs: node.outputs });

const NONE: RunSnapshotOverlay = {
  nodes: [],
  edges: [],
  sinceRun: new Map(),
  ghostEdgeIds: new Set(),
};

/**
 * The graph to draw. Without a live run's snapshot it is the live graph as it is; with one, the
 * live graph plus the snapshot's ghosts, and every node marked where it differs.
 */
export function runSnapshotOverlay(
  nodes: readonly Node[],
  edges: readonly Edge[],
  snapshot: { nodes: readonly Node[]; edges: readonly Edge[] } | undefined,
): RunSnapshotOverlay {
  if (snapshot === undefined) return { ...NONE, nodes: [...nodes], edges: [...edges] };
  const liveById = new Map(nodes.map((node) => [node.id, node]));
  const sinceRun = new Map<Id, SinceRun>();
  const ghosts: Node[] = [];
  for (const frozen of snapshot.nodes) {
    const live = liveById.get(frozen.id);
    if (live === undefined) {
      ghosts.push(frozen);
      sinceRun.set(frozen.id, 'removed');
    } else if (executed(live) !== executed(frozen)) {
      sinceRun.set(frozen.id, 'changed');
    }
  }
  const drawnIds = new Set([...nodes.map((node) => node.id), ...ghosts.map((node) => node.id)]);
  const liveEdgeIds = new Set(edges.map((edge) => edge.id));
  const ghostEdges = snapshot.edges.filter(
    (edge) =>
      !liveEdgeIds.has(edge.id) && drawnIds.has(edge.from.nodeId) && drawnIds.has(edge.to.nodeId),
  );
  return {
    nodes: [...nodes, ...ghosts],
    edges: [...edges, ...ghostEdges],
    sinceRun,
    ghostEdgeIds: new Set(ghostEdges.map((edge) => edge.id)),
  };
}
