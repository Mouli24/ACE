import {
  rosterFor,
  type Id,
  type Node,
  type NodeKind,
  type ProviderType,
  type RosterEntry,
} from '@ace/contracts';

/**
 * What the Domain projection needs besides a run's events (D303): who is on the board. It comes
 * from the run's immutable snapshot (BR-04), so a node renamed or deleted since keeps the name and
 * handle it ran with — and the projection stays a pure function of the snapshot and the log.
 */
export interface DomainContext {
  runId: Id;
  /** The addressable nodes, with their handles (D308). */
  roster: readonly RosterEntry[];
  /** Every node in the snapshot, addressable or not, by id. */
  nodes: ReadonlyMap<Id, { name: string; kind: NodeKind }>;
  /** Provider ids to their type, for pricing turns recorded before Domain (D306). */
  providerTypes?: ReadonlyMap<Id, ProviderType>;
}

export function domainContextFor(
  runId: Id,
  snapshotNodes: readonly Node[],
  providerTypes?: ReadonlyMap<Id, ProviderType>,
): DomainContext {
  return {
    runId,
    roster: rosterFor(snapshotNodes),
    nodes: new Map(
      snapshotNodes.map((node): [Id, { name: string; kind: NodeKind }] => [
        node.id,
        { name: node.name, kind: node.kind },
      ]),
    ),
    ...(providerTypes === undefined ? {} : { providerTypes }),
  };
}

/** How a node is named in a sentence: its handle when it has one, else its name, else its id. */
export function labelOf(context: DomainContext, nodeId: Id): string {
  const entry = context.roster.find((each) => each.nodeId === nodeId);
  if (entry !== undefined) return `@${entry.handle}`;
  return context.nodes.get(nodeId)?.name ?? nodeId;
}
