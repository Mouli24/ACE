import {
  validateLoopConfig,
  type Edge,
  type LoopConfig,
  type LoopConfigCheck,
  type LoopGraph,
} from '@ace/contracts';

/**
 * A loop config the contract accepts, so a probe is never refused for a reason the editor is about
 * to supply. `canBeLoopEdge` asks a structural question — may this arrow be the graph's one legal
 * cycle — and the numbers come later, from `LoopConfigFields`. It has no exit condition, like the
 * loops the Canvas draws (D404), so a source without a json output is not refused for lacking one.
 */
export const PROBE_LOOP_CONFIG: LoopConfig = {
  maxIterations: 1,
  onMax: 'continue',
};

/** An exit condition the contract accepts, for probing one exit field at a time. */
export const PROBE_EXIT_CONDITION: NonNullable<LoopConfig['exitCondition']> = {
  path: 'verdict',
  equals: true,
};

/**
 * Whether an edge may become a loop edge (FR-CON-007), which is the question the Canvas's "Make
 * loop edge" menu item has to answer before it offers itself.
 *
 * The verdict is the contract's own `validateLoopConfig`, never a copy of its rules, so the menu
 * and the engine's graph-ops can never disagree: the target must be upstream of the source along
 * data edges, and the body must not overlap another loop's. The refusal carries the contract's reason, ready to show as why the
 * menu item is disabled.
 *
 * Pure. The candidate may be an edge already in `edges` (a data edge being converted) or one only
 * drawn so far; a data edge of the same id is skipped by the contract's own body check.
 */
export function canBeLoopEdge(
  edge: Pick<Edge, 'id' | 'from' | 'to'>,
  nodes: LoopGraph['nodes'],
  edges: LoopGraph['edges'],
): LoopConfigCheck {
  return validateLoopConfig(
    { id: edge.id, kind: 'loop', from: edge.from, to: edge.to, loop: PROBE_LOOP_CONFIG },
    { nodes, edges },
  );
}
