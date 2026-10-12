import type { LoopConfig } from '@ace/contracts';
import { BaseEdge, type Edge as FlowEdge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';

import { EDGE_HIT_WIDTH, interactionPath } from '../../nodes/TypedEdge';

/**
 * What a loop edge carries on the Canvas. The iteration arrives as edge data — a prop, not a read
 * of the run store — so the chip is drawn from whatever the caller knows and can be tested on its
 * own (the Canvas passes the run's iteration for this edge).
 */
export type LoopFlowEdgeData = {
  kind: 'loop';
  loop: LoopConfig;
  /** The iteration the loop is on, 1-based. Absent when no run has reached it. */
  iteration?: number;
  /** True while the run is live. */
  running?: boolean;
};

export type AceLoopFlowEdge = FlowEdge<LoopFlowEdgeData, 'loop'>;

/** The edge type name to register on the Canvas: `edgeTypes = { ..., [LOOP_EDGE_TYPE]: LoopEdge }`. */
export const LOOP_EDGE_TYPE = 'loop';

/** The hover title: how far the loop may go, when it exits, and what happens at the maximum. */
export function describeLoop(loop: LoopConfig | undefined): string {
  if (loop === undefined) return 'Loop edge';
  const { maxIterations, exitCondition, onMax } = loop;
  return [
    `Loops at most ${maxIterations}×`,
    `exits when ${exitCondition.path} = ${String(exitCondition.equals)}`,
    `at the maximum: ${onMax}`,
  ].join(' · ');
}

/**
 * A loop edge (FR-CON-007) as React Flow sees it: an invisible band along the theme's curve, so it
 * can be selected, deleted and right-clicked ("Loop settings"). The Canvas's edge layer draws it as
 * the theme draws every edge, with the chip `↩ loop · max N` (and `· i/N` once a run reaches it,
 * FR-PAR-005) — D332. The iteration and liveness stay on this element for anything that reads them.
 */
export const LoopEdge = memo(function LoopEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<AceLoopFlowEdge>) {
  const iteration = data?.iteration;
  return (
    <g
      data-testid={`loop-edge-${id}`}
      data-kind="loop"
      data-iteration={iteration === undefined ? 'none' : String(iteration)}
      data-running={data?.running === true ? 'true' : 'false'}
    >
      <title>{describeLoop(data?.loop)}</title>
      <BaseEdge
        id={id}
        path={interactionPath(sourceX, sourceY, targetX, targetY)}
        interactionWidth={EDGE_HIT_WIDTH}
        style={{ stroke: 'transparent' }}
      />
    </g>
  );
});

/** Spread into the Canvas's `edgeTypes` beside `typed`. */
export const loopEdgeType = { [LOOP_EDGE_TYPE]: LoopEdge } as const;
