import type { DataType, EdgeKind } from '@ace/contracts';
import { BaseEdge, getBezierPath, type Edge as FlowEdge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';

export type FlowEdgeData = { dataType: DataType; kind: EdgeKind };
export type AceFlowEdge = FlowEdge<FlowEdgeData, 'typed'>;

/**
 * A data edge (FR-CON-006): the label is the port data type; hovering says "no data yet" until a
 * run has transferred something (round 2 fills the summary in).
 */
export const TypedEdge = memo(function TypedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<AceFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const label = data?.dataType ?? '';
  return (
    <g data-testid={`edge-${id}`} data-datatype={label}>
      <title>no data yet</title>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: selected ? 'var(--color-selection)' : 'var(--color-fg-muted)',
          strokeWidth: selected ? 2.5 : 1.5,
        }}
      />
      <g transform={`translate(${labelX}, ${labelY})`} data-testid={`edge-label-${id}`}>
        <rect
          x={-18}
          y={-8}
          width={36}
          height={16}
          rx={8}
          fill="var(--color-panel)"
          stroke="var(--color-border)"
        />
        <text
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={9}
          fontFamily="var(--font-machine)"
          fill="var(--color-fg-muted)"
        >
          {label}
        </text>
      </g>
    </g>
  );
});

export const edgeTypes = { typed: TypedEdge };
