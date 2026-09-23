import type { DataType, EdgeKind } from '@ace/contracts';
import { BaseEdge, getBezierPath, type Edge as FlowEdge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';

import { useEdgeTransfer } from '../runs/run-store';

/** How long an `edge.transfer` keeps the edge animated (FR-EXE-015). */
const TRANSFER_HIGHLIGHT_MS = 2_000;

export type FlowEdgeData = { dataType: DataType; kind: EdgeKind };
export type AceFlowEdge = FlowEdge<FlowEdgeData, 'typed'>;

/**
 * A data edge (FR-CON-006). The label is the port data type, and the title says "no data yet" until
 * a run delivers an envelope over it — then it carries the engine's own ≤120-character summary and
 * the edge animates for a moment, so a glance at the Canvas shows where the run is (FR-EXE-015).
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
  const transfer = useEdgeTransfer(id);
  const recent = transfer !== undefined && Date.now() - transfer.at < TRANSFER_HIGHLIGHT_MS;
  return (
    <g
      data-testid={`edge-${id}`}
      data-datatype={label}
      data-transferred={transfer ? 'true' : 'false'}
      data-animating={recent ? 'true' : 'false'}
    >
      <title>{transfer ? transfer.summary : 'no data yet'}</title>
      <BaseEdge
        id={id}
        path={path}
        className={recent ? 'ace-edge-flowing' : undefined}
        style={{
          stroke: recent
            ? 'var(--color-status-RUNNING)'
            : selected
              ? 'var(--color-selection)'
              : 'var(--color-fg-muted)',
          strokeWidth: selected || recent ? 2.5 : 1.5,
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
