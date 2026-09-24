import type { Edge, Node, Port, Provider, ProviderType } from '@ace/contracts';

import type { AceFlowNode } from '../nodes/NodeCard';
import type { AceFlowEdge } from '../nodes/TypedEdge';

export type PortKeyHandler = (port: Port, direction: 'in' | 'out', nodeId: string) => void;

/** Contract nodes → React Flow nodes. Positions are the contract positions; the engine owns them. */
export function toFlowNodes(
  nodes: readonly Node[],
  edges: readonly Edge[],
  armedPortId: string | undefined,
  onPortKey: PortKeyHandler,
  providers: readonly Provider[] = [],
  /** False while `GET /providers` is in flight: an empty list then means "unknown", not "gone". */
  providersKnown = true,
): AceFlowNode[] {
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.from.portId);
    connected.add(edge.to.portId);
  }
  const typeById = new Map<string, ProviderType>(providers.map((p) => [p.id, p.type]));
  return nodes.map((node) => {
    const providerId = (node.config as { providerId?: string }).providerId;
    const provider = providerId === undefined ? undefined : typeById.get(providerId);
    // FR-PRV-005: the node still names a provider, but the engine no longer has it. Only claimed
    // once the list has actually arrived, or every node would flash the badge on first paint.
    const providerMissing = providersKnown && providerId !== undefined && provider === undefined;
    return {
      id: node.id,
      type: 'ace',
      position: node.position,
      data: {
        node,
        connectedPortIds: connected,
        armedPortId,
        onPortKey,
        ...(provider === undefined ? {} : { provider }),
        ...(providerMissing ? { providerMissing: true } : {}),
      },
    };
  });
}

/** Contract edges → React Flow edges; the label data type comes from the source port. */
export function toFlowEdges(edges: readonly Edge[], nodes: readonly Node[]): AceFlowEdge[] {
  const portType = new Map<string, Port['dataType']>();
  for (const node of nodes) for (const port of node.outputs) portType.set(port.id, port.dataType);
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.from.nodeId,
    sourceHandle: edge.from.portId,
    target: edge.to.nodeId,
    targetHandle: edge.to.portId,
    type: 'typed',
    data: { dataType: portType.get(edge.from.portId) ?? 'text', kind: edge.kind },
  }));
}
