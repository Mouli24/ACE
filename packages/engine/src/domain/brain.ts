import type { EnvelopeKind, Id, RoutingMode } from '@ace/contracts';

/**
 * The Brain's router (D304, D310). Every envelope passes through it and is logged `by: 'brain'`. In
 * supervised mode it forwards with no model call; in manual mode it holds everything for the human.
 * The loop guard counts QUERY and FLAG envelopes between each unordered pair of nodes, and holds the
 * one that goes over the limit — which is what turns the run BLOCKED `LOOP_GUARD` (D305).
 */

/** The kinds the loop guard counts: the ones that send a node back to another one. */
export const LOOP_COUNTED_KINDS: ReadonlySet<EnvelopeKind> = new Set<EnvelopeKind>([
  'QUERY',
  'FLAG',
]);

/** One key per unordered pair, so A→B and B→A count together. */
export const pairKey = (a: Id, b: Id): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Count an envelope against each pair it joins; HANDOFF and ANSWER are not counted. */
export function countLoop(
  counts: Map<string, number>,
  kind: EnvelopeKind,
  from: Id,
  to: readonly Id[],
): void {
  if (!LOOP_COUNTED_KINDS.has(kind)) return;
  for (const nodeId of to) {
    const key = pairKey(from, nodeId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}

export interface BrainRouteInput {
  mode: RoutingMode;
  kind: EnvelopeKind;
  from: Id;
  to: readonly Id[];
  /** The pair counts, this envelope already counted. */
  counts: ReadonlyMap<string, number>;
  limit: number;
}

export type BrainRoute =
  | { decision: 'FORWARDED' }
  | { decision: 'HELD'; reason: 'manual routing' }
  | { decision: 'HELD'; reason: 'LOOP_GUARD'; loopGuard: { nodeIds: Id[]; count: number } };

export function routeEnvelope(input: BrainRouteInput): BrainRoute {
  if (input.mode === 'manual') return { decision: 'HELD', reason: 'manual routing' };
  if (LOOP_COUNTED_KINDS.has(input.kind)) {
    for (const nodeId of input.to) {
      const count = input.counts.get(pairKey(input.from, nodeId)) ?? 0;
      if (count > input.limit) {
        return {
          decision: 'HELD',
          reason: 'LOOP_GUARD',
          loopGuard: { nodeIds: [input.from, nodeId].sort(), count },
        };
      }
    }
  }
  return { decision: 'FORWARDED' };
}

/** One line of the Brain's digest (D304): what was sent, to whom, and what the router did. */
export function digestLine(
  label: (nodeId: Id) => string,
  envelope: { kind: EnvelopeKind; from: Id; to: readonly Id[]; summary: string },
  decision: string,
): string {
  return `${envelope.kind} ${label(envelope.from)} → ${envelope.to.map(label).join(', ')}: ${envelope.summary} (${decision})`;
}
