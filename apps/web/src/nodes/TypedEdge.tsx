import type { DataType, EdgeKind, ProviderType } from '@ace/contracts';
import { BaseEdge, type Edge as FlowEdge, type EdgeProps } from '@xyflow/react';
import { memo, useEffect, useState } from 'react';

import { edgePath } from '../canvas/viewport';
import { useEdgeTransfer } from '../runs/run-store';

/** How long an `edge.transfer` marks the edge as just crossed (FR-EXE-015). */
const TRANSFER_HIGHLIGHT_MS = 2_000;

/** How wide a band around an edge takes clicks, right-clicks and hovers (D332). */
export const EDGE_HIT_WIDTH = 16;

/**
 * React Flow measures a 12px handle and puts an edge's ends on its outer sides; the theme's anchor
 * is the handle's centre, so the ends move 6px back in (`.ace-port`, theme.css).
 */
const HANDLE_HALF = 6;

export type FlowEdgeData = {
  dataType: DataType;
  kind: EdgeKind;
  /** The provider type of the source (else the target) node. */
  accent?: ProviderType;
};
export type AceFlowEdge = FlowEdge<FlowEdgeData, 'typed'>;

/** The theme's curve between the two anchors React Flow reports for this edge's handles. */
export function interactionPath(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): string {
  return edgePath(sourceX - HANDLE_HALF, sourceY, targetX + HANDLE_HALF, targetY).d;
}

/**
 * A data edge (FR-CON-006) as React Flow sees it: an invisible band along the theme's curve, so
 * selection, the Delete key and the edge menu keep working. What you see — the glow, the dashed
 * line, the dots and the data-type chip — is drawn above the nodes by the Canvas's edge layer
 * (D332). The title still says "no data yet" until a run delivers an envelope over the edge, then
 * carries the engine's own ≤120-character summary (FR-EXE-015).
 */
export const TypedEdge = memo(function TypedEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<AceFlowEdge>) {
  const transfer = useEdgeTransfer(id);
  /**
   * The "just crossed" mark has to switch itself off: comparing `Date.now()` during render never
   * re-runs, because nothing about this edge changes once the transfer has been folded.
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

  return (
    <g
      data-testid={`edge-${id}`}
      data-datatype={data?.dataType ?? ''}
      data-transferred={transfer ? 'true' : 'false'}
      data-animating={recent ? 'true' : 'false'}
    >
      <title>{transfer ? transfer.summary : 'no data yet'}</title>
      <BaseEdge
        id={id}
        path={interactionPath(sourceX, sourceY, targetX, targetY)}
        interactionWidth={EDGE_HIT_WIDTH}
        style={{ stroke: 'transparent' }}
      />
    </g>
  );
});

export const edgeTypes = { typed: TypedEdge };
