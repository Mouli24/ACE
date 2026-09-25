import type { Edge, Node, Port, Provider, ProviderType } from '@ace/contracts';

import { LOOP_EDGE_TYPE, type AceLoopFlowEdge } from '../edges/loop/LoopEdge';
import type { AceFlowNode } from '../nodes/NodeCard';
import type { AceFlowEdge } from '../nodes/TypedEdge';

/** Either kind of edge React Flow is handed: a typed data edge, or the one loop edge (FR-CON-007). */
export type AceAnyFlowEdge = AceFlowEdge | AceLoopFlowEdge;

/** What the live run knows about a loop edge, so the badge can count iterations (FR-PAR-005). */
export interface LoopLiveState {
  iteration?: number;
  running?: boolean;
}

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

/**
 * Contract edges → React Flow edges; the label data type comes from the source port.
 *
 * A `kind: 'loop'` edge becomes the dashed loop edge instead (FR-CON-007). Its `loop` config is what
 * the engine stored, and `live` — the iteration the run is on — is looked up per edge rather than
 * read from a store here, so this stays pure and testable.
 */
export function toFlowEdges(
  edges: readonly Edge[],
  nodes: readonly Node[],
  live: (edge: Edge) => LoopLiveState = () => ({}),
): AceAnyFlowEdge[] {
  const portType = new Map<string, Port['dataType']>();
  for (const node of nodes) for (const port of node.outputs) portType.set(port.id, port.dataType);
  return edges.map((edge): AceAnyFlowEdge => {
    const ends = {
      id: edge.id,
      source: edge.from.nodeId,
      sourceHandle: edge.from.portId,
      target: edge.to.nodeId,
      targetHandle: edge.to.portId,
    };
    // A loop edge with no config cannot exist on the engine (BR-05), but a stale cache could hold
    // one; it is drawn as the data edge it structurally is rather than crashing the Canvas.
    if (edge.kind === 'loop' && edge.loop !== undefined) {
      const { iteration, running } = live(edge);
      return {
        ...ends,
        type: LOOP_EDGE_TYPE,
        data: {
          kind: 'loop',
          loop: edge.loop,
          ...(iteration === undefined ? {} : { iteration }),
          ...(running === undefined ? {} : { running }),
        },
      };
    }
    return {
      ...ends,
      type: 'typed',
      data: { dataType: portType.get(edge.from.portId) ?? 'text', kind: edge.kind },
    };
  });
}
