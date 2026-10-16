import type { DataType, Edge, Node, Port, Provider, ProviderType } from '@ace/contracts';

import { LOOP_EDGE_TYPE, type AceLoopFlowEdge } from '../edges/loop/LoopEdge';
import type { AceFlowNode } from '../nodes/NodeCard';
import type { AceFlowEdge } from '../nodes/TypedEdge';
import { agentsOf } from '../theme/agents';

/** Either kind of edge React Flow is handed: a typed data edge, or the one loop edge (FR-CON-007). */
export type AceAnyFlowEdge = AceFlowEdge | AceLoopFlowEdge;

/** What the live run knows about a loop edge, so the badge can count iterations (FR-PAR-005). */
export interface LoopLiveState {
  iteration?: number;
  running?: boolean;
}

export type PortKeyHandler = (port: Port, direction: 'in' | 'out', nodeId: string) => void;

const providerIdOf = (node: Node): string | undefined =>
  (node.config as { providerId?: string }).providerId;

const providerTypes = (providers: readonly Provider[]): Map<string, ProviderType> =>
  new Map(providers.map((p) => [p.id, p.type]));

/**
 * What the cards say about their place in the graph (D332): each Agent/Model node's stage number
 * (its 1-based place in `agentsOf`), the stages every other node's data edges feed, and the data
 * types arriving on an Output node.
 */
function graphFacts(nodes: readonly Node[], edges: readonly Edge[]) {
  const stage = new Map(agentsOf(nodes).map((agent) => [agent.nodeId, agent.index + 1]));
  const outType = new Map<string, DataType>();
  for (const node of nodes) for (const port of node.outputs) outType.set(port.id, port.dataType);
  const feeds = new Map<string, Set<number>>();
  const receives = new Map<string, Set<DataType>>();
  for (const edge of edges) {
    if (edge.kind !== 'data') continue;
    const fed = stage.get(edge.to.nodeId);
    if (fed !== undefined && !stage.has(edge.from.nodeId)) {
      const set = feeds.get(edge.from.nodeId) ?? new Set<number>();
      set.add(fed);
      feeds.set(edge.from.nodeId, set);
    }
    const type = outType.get(edge.from.portId);
    if (type !== undefined) {
      const set = receives.get(edge.to.nodeId) ?? new Set<DataType>();
      set.add(type);
      receives.set(edge.to.nodeId, set);
    }
  }
  return { stage, feeds, receives };
}

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
  const byId = new Map(providers.map((p) => [p.id, p]));
  const facts = graphFacts(nodes, edges);
  return nodes.map((node) => {
    const providerId = providerIdOf(node);
    const record = providerId === undefined ? undefined : byId.get(providerId);
    // FR-PRV-005: the node still names a provider, but the engine no longer has it. Only claimed
    // once the list has actually arrived, or every node would flash the badge on first paint.
    const providerMissing = providersKnown && providerId !== undefined && record === undefined;
    const stage = facts.stage.get(node.id);
    const feeds = facts.feeds.get(node.id);
    const receives = node.kind === 'output' ? facts.receives.get(node.id) : undefined;
    return {
      id: node.id,
      type: 'ace',
      position: node.position,
      data: {
        node,
        connectedPortIds: connected,
        armedPortId,
        onPortKey,
        ...(record === undefined ? {} : { provider: record.type, providerName: record.name }),
        ...(providerMissing ? { providerMissing: true } : {}),
        ...(stage === undefined ? {} : { stage }),
        ...(feeds === undefined ? {} : { feeds: [...feeds].sort((a, b) => a - b) }),
        ...(receives === undefined ? {} : { receives: [...receives] }),
      },
    };
  });
}

/**
 * Contract edges → React Flow edges; the label data type comes from the source port, and the
 * accent — the colour the edge takes once data crosses it (FR-EXE-015) — from the source node's
 * provider type, or the target's when the source has none (an Input feeding an Agent).
 *
 * A `kind: 'loop'` edge becomes the dashed loop edge instead (FR-CON-007). Its `loop` config is what
 * the engine stored, and `live` — the iteration the run is on — is looked up per edge rather than
 * read from a store here, so this stays pure and testable.
 *
 * A `kind: 'order'` edge ("run after", D373) is not handed to React Flow at all: it has no ports
 * for React Flow to attach it to. `OrderEdgeLayer` draws it from card to card instead.
 */
export function toFlowEdges(
  edges: readonly Edge[],
  nodes: readonly Node[],
  live: (edge: Edge) => LoopLiveState = () => ({}),
  providers: readonly Provider[] = [],
): AceAnyFlowEdge[] {
  const portType = new Map<string, Port['dataType']>();
  for (const node of nodes) for (const port of node.outputs) portType.set(port.id, port.dataType);
  const typeById = providerTypes(providers);
  const accentOf = new Map<string, ProviderType>();
  for (const node of nodes) {
    const providerId = providerIdOf(node);
    const type = providerId === undefined ? undefined : typeById.get(providerId);
    if (type !== undefined) accentOf.set(node.id, type);
  }
  return edges.flatMap((edge): AceAnyFlowEdge[] => {
    if (edge.kind === 'order') return [];
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
      return [
        {
          ...ends,
          type: LOOP_EDGE_TYPE,
          data: {
            kind: 'loop',
            loop: edge.loop,
            ...(iteration === undefined ? {} : { iteration }),
            ...(running === undefined ? {} : { running }),
          },
        },
      ];
    }
    const accent = accentOf.get(edge.from.nodeId) ?? accentOf.get(edge.to.nodeId);
    return [
      {
        ...ends,
        type: 'typed',
        data: {
          dataType: portType.get(edge.from.portId) ?? 'text',
          kind: edge.kind,
          ...(accent === undefined ? {} : { accent }),
        },
      },
    ];
  });
}
