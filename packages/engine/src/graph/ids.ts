import { derivePorts, portId, type Edge, type Id, type Node } from '@ace/contracts';

import { newId } from '../ids.js';

/** `<nodeId>:in|out:<name>` — the stable format §2.4 fixes. */
export interface ParsedPortId {
  nodeId: Id;
  direction: 'in' | 'out';
  name: string;
}

export function parsePortId(value: string): ParsedPortId | null {
  const match = /^([^:]+):(in|out):(.+)$/.exec(value);
  if (match === null) return null;
  return { nodeId: match[1]!, direction: match[2] as 'in' | 'out', name: match[3]! };
}

export interface RemappedGraph {
  nodes: Node[];
  edges: Edge[];
}

/**
 * Copy a graph under fresh ids (`duplicate` and `import`, FR-WF-003 / FR-WF-008).
 *
 * Node ids change, and because a port id embeds its node id (§2.4) every edge endpoint has to be
 * rewritten too. Ports are re-derived rather than string-patched, so a copy is exactly what the
 * node's config says it should be.
 */
export function remapGraph(
  nodes: readonly Node[],
  edges: readonly Edge[],
  workflowId: Id,
): RemappedGraph {
  const idByOldId = new Map<Id, Id>();
  for (const node of nodes) idByOldId.set(node.id, newId());

  const remappedNodes = nodes.map((node): Node => {
    const id = idByOldId.get(node.id)!;
    const ports = derivePorts({ id, kind: node.kind, config: node.config } as Parameters<
      typeof derivePorts
    >[0]);
    return { ...node, id, workflowId, inputs: ports.inputs, outputs: ports.outputs } as Node;
  });

  const remapEndpoint = (endpoint: Edge['from']): Edge['from'] | null => {
    const parsed = parsePortId(endpoint.portId);
    const nodeId = idByOldId.get(endpoint.nodeId);
    if (parsed === null || nodeId === undefined) return null;
    return { nodeId, portId: portId(nodeId, parsed.direction, parsed.name) };
  };

  const remappedEdges: Edge[] = [];
  for (const edge of edges) {
    const from = remapEndpoint(edge.from);
    const to = remapEndpoint(edge.to);
    // An edge whose endpoints no longer resolve is dropped rather than copied dangling.
    if (from === null || to === null) continue;
    remappedEdges.push({ ...edge, id: newId(), workflowId, from, to });
  }

  return { nodes: remappedNodes, edges: remappedEdges };
}
