import type { LoopConfig } from '@ace/contracts';
import { BaseEdge, getBezierPath, type Edge as FlowEdge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';

import { EDGE_LABEL_STYLE } from '../../nodes/TypedEdge';

/**
 * What a loop edge carries on the Canvas. The iteration arrives as edge data — a prop, not a read
 * of the run store — so the badge is drawn from whatever the caller knows and can be tested on its
 * own (the Canvas passes the live run's iteration for this edge).
 */
export type LoopFlowEdgeData = {
  kind: 'loop';
  loop: LoopConfig;
  /** The iteration the loop is on, 1-based. Absent when no run is going: no badge. */
  iteration?: number;
  /** True while the run is live, which is the only time the dash marches. */
  running?: boolean;
};

export type AceLoopFlowEdge = FlowEdge<LoopFlowEdgeData, 'loop'>;

/** The edge type name to register on the Canvas: `edgeTypes = { ..., [LOOP_EDGE_TYPE]: LoopEdge }`. */
export const LOOP_EDGE_TYPE = 'loop';

/** An arrow pointing back the way the edge goes, so the one legal cycle reads as a cycle. */
const ARROW_BACK = '↩';

function describe(loop: LoopConfig | undefined): string {
  if (loop === undefined) return 'Loop edge';
  const { maxIterations, exitCondition, onMax } = loop;
  return [
    `Loops at most ${maxIterations}×`,
    `exits when ${exitCondition.path} = ${String(exitCondition.equals)}`,
    `at the maximum: ${onMax}`,
  ].join(' · ');
}

/**
 * A loop edge (FR-CON-007). Dashed and in the WAITING hue through `.ace-loop-edge`, so it can never
 * be mistaken for a data edge; the dash marches backwards while the run is live, and an arrow-back
 * glyph says which way the jump goes even when nothing is moving. The label says how far it may go
 * (`loop · max N`), in the same style as a data edge's label; during a run the badge shows the
 * iteration against the maximum, which is the one number a loop needs watching (FR-PAR-005).
 */
export const LoopEdge = memo(function LoopEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<AceLoopFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const iteration = data?.iteration;
  const running = data?.running === true;
  const maxIterations = data?.loop.maxIterations;

  return (
    <g
      data-testid={`loop-edge-${id}`}
      data-kind="loop"
      data-iteration={iteration === undefined ? 'none' : String(iteration)}
      data-running={running ? 'true' : 'false'}
    >
      <title>{describe(data?.loop)}</title>
      <BaseEdge
        id={id}
        path={path}
        className={running ? 'ace-loop-edge ace-loop-edge-running' : 'ace-loop-edge'}
        style={{
          strokeWidth: selected ? 2.5 : 1.5,
          strokeLinecap: 'round',
          ...(selected ? { stroke: 'var(--color-selection)' } : {}),
        }}
      />
      <g transform={`translate(${labelX}, ${labelY - 7})`}>
        <text data-testid={`loop-edge-label-${id}`} textAnchor="middle" style={EDGE_LABEL_STYLE}>
          <tspan data-testid={`loop-edge-glyph-${id}`} fill="var(--color-status-WAITING)">
            {ARROW_BACK}
          </tspan>{' '}
          {maxIterations === undefined ? 'loop' : `loop · max ${maxIterations}`}
        </text>
        {iteration !== undefined && (
          <g data-testid={`loop-edge-iteration-${id}`} transform="translate(0, 16)">
            <rect
              x={-20}
              y={-8}
              width={40}
              height={16}
              rx={8}
              fill="var(--color-panel)"
              stroke="var(--color-status-WAITING)"
            />
            <text
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={9}
              fontFamily="var(--font-machine)"
              fill="var(--color-status-WAITING)"
            >
              {maxIterations === undefined ? iteration : `${iteration}/${maxIterations}`}
            </text>
          </g>
        )}
      </g>
    </g>
  );
});

/** Spread into the Canvas's `edgeTypes` beside `typed`. */
export const loopEdgeType = { [LOOP_EDGE_TYPE]: LoopEdge } as const;
