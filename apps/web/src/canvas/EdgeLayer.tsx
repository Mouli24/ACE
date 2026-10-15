import type { Node } from '@ace/contracts';
import { ViewportPortal, useStore, type ReactFlowState } from '@xyflow/react';
import { memo, useMemo } from 'react';

import { anchorOfPort, type Point } from '../nodes/anchors';
import type { AceAnyFlowEdge } from './to-flow';
import { edgePath } from './viewport';

/** What an edge's chip says: a data edge its data type, a loop edge its limit and iteration. */
export type EdgeLabel =
  { kind: 'data'; dataType: string } | { kind: 'loop'; max: number; iteration?: number };

export interface EdgeStrokeProps {
  id: string;
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  selected: boolean;
}

/**
 * One edge as the theme draws it (D332): a 6px glow at `--edgeGlow` (0.3 when the edge is
 * selected), the 1.6px dashed line flowing along it, a filled dot where it leaves and a ringed dot
 * where it arrives.
 */
export const EdgeStroke = memo(function EdgeStroke({
  id,
  d,
  x1,
  y1,
  x2,
  y2,
  selected,
}: EdgeStrokeProps) {
  return (
    <g data-testid={`edge-line-${id}`} data-selected={selected ? 'true' : 'false'}>
      <path
        d={d}
        style={{
          fill: 'none',
          stroke: '#ef6b3f',
          strokeWidth: 6,
          opacity: selected ? 0.3 : 'var(--edgeGlow)',
        }}
      />
      <path
        d={d}
        className="ace-edge-flow"
        style={{ fill: 'none', stroke: '#ef6b3f', strokeWidth: 1.6, strokeDasharray: '5 5' }}
      />
      <circle cx={x1} cy={y1} r={3} style={{ fill: '#ef6b3f' }} />
      <circle
        cx={x2}
        cy={y2}
        r={3.5}
        style={{ fill: 'var(--canvas)', stroke: '#ef6b3f', strokeWidth: 1.6 }}
      />
    </g>
  );
});

const CHIP =
  'pointer-events-none absolute whitespace-nowrap rounded-[5px] border border-[var(--frameLine)] bg-[var(--chip)] px-[8px] py-[3px] text-[9.5px] font-medium text-[var(--muted)]';

/** The label chip at the curve's midpoint: the real data type, or `↩ loop · max N` (`· i/N`). */
export const EdgeChip = memo(function EdgeChip({
  id,
  mx,
  my,
  label,
}: {
  id: string;
  mx: number;
  my: number;
  label: EdgeLabel;
}) {
  const style = { left: mx, top: my, transform: 'translate(-50%,-50%)' };
  if (label.kind === 'data') {
    return (
      <div data-testid={`edge-label-${id}`} className={CHIP} style={style}>
        {label.dataType}
      </div>
    );
  }
  return (
    <div data-testid={`loop-edge-label-${id}`} className={CHIP} style={style}>
      <span data-testid={`loop-edge-glyph-${id}`}>↩</span> loop · max {label.max}
      {label.iteration !== undefined && (
        <>
          {' · '}
          <span data-testid={`loop-edge-iteration-${id}`}>
            {label.iteration}/{label.max}
          </span>
        </>
      )}
    </div>
  );
});

function labelOf(edge: AceAnyFlowEdge): EdgeLabel {
  const data = edge.data;
  if (data !== undefined && 'loop' in data) {
    return {
      kind: 'loop',
      max: data.loop.maxIterations,
      ...(data.iteration === undefined ? {} : { iteration: data.iteration }),
    };
  }
  return { kind: 'data', dataType: data?.dataType ?? 'text' };
}

const selectNodes = (state: ReactFlowState) => state.nodes;

/** How a port's dot shows above the edges: fully, or dimmed (an incompatible drop, D350). */
export type PortDotLook = 'on' | 'dim';

/**
 * PG-1.1 (D350): ports sit above the edge layer. The edges are drawn over the nodes (D332), so a
 * port's own handle — inside its card — would sit under any edge crossing it; this layer repeats
 * each shown port's dot just above the edges, at the same anchor and in the same colour. It touches
 * no pointer: the handle underneath still takes the press.
 */
export const PortDotLayer = memo(function PortDotLayer({
  nodes,
  shown,
}: {
  nodes: readonly Node[];
  shown: ReadonlyMap<string, PortDotLook>;
}) {
  const live = useStore(selectNodes);
  if (shown.size === 0) return null;
  const positions = new Map(live.map((node) => [node.id, node.position]));
  const dots = nodes.flatMap((node) => {
    const at = positions.get(node.id);
    if (at === undefined) return [];
    return [...node.inputs, ...node.outputs].flatMap((port) => {
      const look = shown.get(port.id);
      const anchor = look === undefined ? undefined : anchorOfPort(node, port.id);
      return look === undefined || anchor === undefined
        ? []
        : [{ id: port.id, x: at.x + anchor.x, y: at.y + anchor.y, look, type: port.dataType }];
    });
  });
  return (
    <ViewportPortal>
      <div
        data-testid="canvas-port-dots"
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 z-[2001]"
      >
        {dots.map((dot) => (
          <span
            key={dot.id}
            data-testid={`port-dot-${dot.id}`}
            data-look={dot.look}
            className="ace-port-dot"
            style={{
              left: dot.x,
              top: dot.y,
              opacity: dot.look === 'dim' ? 0.35 : 1,
              ['--port-color' as string]: `var(--port-${dot.type})`,
            }}
          />
        ))}
      </div>
    </ViewportPortal>
  );
});

/**
 * Every edge's look, drawn above the nodes as the theme draws them (D332). It lives in React Flow's
 * viewport portal — after the node layer, in the same pan and zoom — and touches no pointer: React
 * Flow's own (invisible) edges take the clicks. The anchors are the ports' theme anchors on the
 * nodes' live positions from React Flow's store, so an edge follows a node while it is dragged.
 */
export const EdgeLayer = memo(function EdgeLayer({
  nodes,
  edges,
}: {
  /** The contract nodes: kinds and port order decide each anchor. */
  nodes: readonly Node[];
  /** The edges React Flow is drawing, with their selection and live loop data. */
  edges: readonly AceAnyFlowEdge[];
}) {
  const live = useStore(selectNodes);

  const ends = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return edges.flatMap((edge) => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      const a: Point | undefined = source && anchorOfPort(source, edge.sourceHandle ?? '');
      const b: Point | undefined = target && anchorOfPort(target, edge.targetHandle ?? '');
      return a && b ? [{ edge, a, b, label: labelOf(edge) }] : [];
    });
  }, [nodes, edges]);

  const positions = new Map(live.map((node) => [node.id, node.position]));
  const drawn = ends.flatMap(({ edge, a, b, label }) => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) return [];
    const x1 = from.x + a.x;
    const y1 = from.y + a.y;
    const x2 = to.x + b.x;
    const y2 = to.y + b.y;
    return [
      {
        id: edge.id,
        x1,
        y1,
        x2,
        y2,
        selected: edge.selected === true,
        label,
        ...edgePath(x1, y1, x2, y2),
      },
    ];
  });

  return (
    <ViewportPortal>
      <div
        data-testid="canvas-edges"
        className="pointer-events-none absolute left-0 top-0 z-[2000]"
      >
        <svg
          className="pointer-events-none absolute left-0 top-0 h-px w-px overflow-visible"
          aria-hidden
        >
          {drawn.map(({ id, d, x1, y1, x2, y2, selected }) => (
            <EdgeStroke
              key={id}
              id={id}
              d={d}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              selected={selected}
            />
          ))}
        </svg>
        {drawn.map(({ id, mx, my, label }) => (
          <EdgeChip key={id} id={id} mx={mx} my={my} label={label} />
        ))}
      </div>
    </ViewportPortal>
  );
});
