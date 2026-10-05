import type { DataType, EdgeKind, ProviderType } from '@ace/contracts';
import { BaseEdge, getBezierPath, type Edge as FlowEdge, type EdgeProps } from '@xyflow/react';
import { memo, useEffect, useState, type CSSProperties } from 'react';

import { useEdgeTransfer } from '../runs/run-store';

/** How long an `edge.transfer` keeps the edge animated (FR-EXE-015). */
const TRANSFER_HIGHLIGHT_MS = 2_000;

export type FlowEdgeData = {
  dataType: DataType;
  kind: EdgeKind;
  /** The provider type that colours the edge once data has crossed it: the source's, else the target's. */
  accent?: ProviderType;
};
export type AceFlowEdge = FlowEdge<FlowEdgeData, 'typed'>;

/**
 * The edge label style, shared with the loop edge: machine font on a canvas-coloured halo, so it
 * reads over the line and the dots without a pill behind it. The whole word is a click target for
 * its edge (React Flow's `.react-flow__edge` would otherwise only hit-test strokes).
 */
export const EDGE_LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--font-machine)',
  fontSize: '9.5px',
  letterSpacing: '0.06em',
  paintOrder: 'stroke',
  stroke: 'var(--color-canvas)',
  strokeWidth: '5px',
  strokeLinejoin: 'round',
  fill: 'var(--color-fg-muted)',
  pointerEvents: 'visiblePainted',
};

/** The arrowhead that closes an edge at its target end. */
export const arrowheadPath = (x: number, y: number): string =>
  `M ${x - 8} ${y - 4.5} L ${x - 1} ${y} L ${x - 8} ${y + 4.5} Z`;

/**
 * A data edge (FR-CON-006). The label is the port data type, and the title says "no data yet" until
 * a run delivers an envelope over it — then it carries the engine's own ≤120-character summary,
 * the edge takes its provider's colour and animates for a moment, so a glance at the Canvas shows
 * where the run is (FR-EXE-015).
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
  /**
   * The highlight has to switch itself off: comparing `Date.now()` during render never re-runs,
   * because nothing about this edge changes once the transfer has been folded, so the edge stayed
   * lit for the rest of the session.
   */
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    if (transfer === undefined) return;
    const left = TRANSFER_HIGHLIGHT_MS - (Date.now() - transfer.at);
    if (left <= 0) {
      setRecent(false);
      return;
    }
    setRecent(true);
    const timer = setTimeout(() => setRecent(false), left);
    return () => clearTimeout(timer);
  }, [transfer]);

  const accent = data?.accent === undefined ? undefined : `var(--color-provider-${data.accent})`;
  const { color, width } = selected
    ? { color: 'var(--color-selection)', width: 2.5 }
    : recent
      ? { color: accent ?? 'var(--color-status-RUNNING)', width: 2 }
      : transfer
        ? { color: accent ?? 'var(--color-fg-faint)', width: 2 }
        : { color: 'var(--color-border-strong)', width: 1.5 };

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
        style={{ stroke: color, strokeWidth: width, strokeLinecap: 'round' }}
      />
      <path data-testid={`edge-arrow-${id}`} d={arrowheadPath(targetX, targetY)} fill={color} />
      {/* The baseline sits 7 px above the curve's midpoint, so the word rides on the line. */}
      <g transform={`translate(${labelX}, ${labelY - 7})`} data-testid={`edge-label-${id}`}>
        <text textAnchor="middle" style={EDGE_LABEL_STYLE}>
          {label}
        </text>
      </g>
    </g>
  );
});

export const edgeTypes = { typed: TypedEdge };
