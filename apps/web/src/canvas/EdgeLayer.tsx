import type { Node } from '@ace/contracts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Icons,
  cn,
} from '@ace/ui';
import { ViewportPortal, useStore, type ReactFlowState } from '@xyflow/react';
import {
  memo,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { anchorOfPort, type Point } from '../nodes/anchors';
import type { EdgeEnd, EdgeTypeOption } from './edge-edit';
import type { PortConnectState } from './interactions/ports';
import { GHOST_EDGE_CLASS } from './run-snapshot';
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
  /** PG-4.4: an edge the live run still walks but the graph lost — drawn faint. */
  ghost?: boolean;
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
  ghost = false,
}: EdgeStrokeProps) {
  return (
    <g
      data-testid={`edge-line-${id}`}
      data-selected={selected ? 'true' : 'false'}
      data-ghost={ghost ? 'true' : undefined}
      opacity={ghost ? 0.35 : undefined}
    >
      <path
        d={d}
        style={{
          fill: 'none',
          stroke: '#ef6b3f',
          // selected: a wider, stronger glow and a heavier line, so a picked edge is unmistakable
          strokeWidth: selected ? 10 : 6,
          opacity: selected ? 0.4 : 'var(--edgeGlow)',
        }}
      />
      <path
        d={d}
        className="ace-edge-flow"
        style={{
          fill: 'none',
          stroke: '#ef6b3f',
          strokeWidth: selected ? 2.4 : 1.6,
          strokeDasharray: '5 5',
        }}
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

/**
 * What the Canvas lets the edge layer do to a data edge (FR-CON-004, FR-CON-006): change its type,
 * remove it, select it, keep it hovered while the pointer is on its chip or handles, and start
 * moving one of its ends. Stable for the Canvas's life, so a hover never re-renders every chip.
 */
export interface EdgeEditApi {
  /** The type dropdown's rows, computed only when the dropdown opens. */
  typeOptions(edgeId: string): EdgeTypeOption[];
  pickType(edgeId: string, option: EdgeTypeOption): void;
  remove(edgeId: string): void;
  select(edgeId: string): void;
  /** The pointer is on (an edge id) or has left (undefined) one of an edge's controls. */
  hover(edgeId: string | undefined): void;
  startReconnect(edgeId: string, end: EdgeEnd, event: ReactPointerEvent): void;
}

/** One end of an edge being dragged to a new port: the moving end follows the pointer. */
export interface EdgeReconnectDrag {
  edgeId: string;
  end: EdgeEnd;
  /** The pointer, in flow coordinates. */
  x: number;
  y: number;
}

const CHIP_BUTTON =
  'nopan nodrag flex cursor-pointer items-center gap-[3px] whitespace-nowrap rounded-[5px] border bg-[var(--chip)] py-[3px] pl-[8px] pr-[5px] text-[9.5px] font-medium text-[var(--muted)] outline-none hover:border-[#ef6b3f] hover:text-[var(--ink)] focus-visible:border-[#ef6b3f] focus-visible:ring-2 focus-visible:ring-[rgba(239,107,63,0.35)]';

/** The type dropdown's rows: every data type, the current one checked, the impossible ones greyed with why. */
function EdgeTypeItems({ edgeId, edit }: { edgeId: string; edit: EdgeEditApi }) {
  // computed once per opening: the dropdown's content mounts only while it is open
  const options = useMemo(() => edit.typeOptions(edgeId), [edit, edgeId]);
  return (
    <>
      <DropdownMenuLabel>Data type</DropdownMenuLabel>
      {options.map((option) => {
        const reason = option.ok ? undefined : option.reason;
        const note = option.ok && !option.current ? option.note : undefined;
        return (
          <DropdownMenuItem
            key={option.type}
            data-testid={`edge-type-option-${option.type}`}
            data-current={option.current ? 'true' : undefined}
            disabled={!option.ok}
            title={reason ?? note}
            aria-label={
              option.current
                ? `${option.type}, current type`
                : reason !== undefined
                  ? `${option.type}, not possible: ${reason}`
                  : `${option.type}${note === undefined ? '' : `, ${note}`}`
            }
            className="h-auto min-h-8 items-start py-[6px]"
            onSelect={() => {
              if (option.ok && !option.current) edit.pickType(edgeId, option);
            }}
          >
            <span
              aria-hidden
              className="mt-[4px] h-[8px] w-[8px] shrink-0 rounded-full"
              style={{ background: `var(--port-${option.type})` }}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{option.type}</span>
              {(reason ?? note) !== undefined && (
                <span className="max-w-[240px] whitespace-normal text-[11px] leading-[1.35] text-[var(--muted)]">
                  {reason ?? note}
                </span>
              )}
            </span>
            {option.current ? (
              <Icons.Check aria-hidden size={14} className="mt-[2px] shrink-0 text-[#ef6b3f]" />
            ) : !option.ok ? (
              <Icons.Ban aria-hidden size={13} className="mt-[2px] shrink-0 opacity-60" />
            ) : null}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/**
 * A data edge's chip once it can be edited: a button naming the type that opens the type dropdown,
 * and — while the edge is hovered, selected or the chip has focus — a ✕ that removes the edge.
 * Delete or Backspace on the chip removes it too.
 */
export const EdgeTypeChip = memo(function EdgeTypeChip({
  id,
  mx,
  my,
  dataType,
  active,
  selected,
  edit,
}: {
  id: string;
  mx: number;
  my: number;
  dataType: string;
  /** Hovered or selected: the ✕ shows. */
  active: boolean;
  selected: boolean;
  edit: EdgeEditApi;
}) {
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    // React Flow's own Delete handler must not remove it a second time
    event.preventDefault();
    event.stopPropagation();
    edit.remove(id);
  };
  return (
    <div
      data-testid={`edge-chip-${id}`}
      className="nopan nodrag nowheel pointer-events-auto absolute flex items-center gap-[3px]"
      style={{ left: mx, top: my, transform: 'translate(-50%,-50%)' }}
      onMouseEnter={() => edit.hover(id)}
      onMouseLeave={() => edit.hover(undefined)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) {
          setFocused(false);
        }
      }}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) edit.select(id);
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid={`edge-label-${id}`}
            aria-label={`Connection type: ${dataType}. Change type`}
            className={cn(
              CHIP_BUTTON,
              selected ? 'border-[#ef6b3f] text-[var(--ink)]' : 'border-[var(--frameLine)]',
            )}
          >
            {dataType}
            <Icons.ChevronDown aria-hidden size={10} />
          </button>
        </DropdownMenuTrigger>
        {open && (
          <DropdownMenuContent aria-label="Connection type" data-testid={`edge-type-menu-${id}`}>
            <EdgeTypeItems edgeId={id} edit={edit} />
          </DropdownMenuContent>
        )}
      </DropdownMenu>
      {(active || focused || open) && (
        <button
          type="button"
          data-testid={`edge-remove-${id}`}
          aria-label="Remove connection"
          title="Remove connection"
          className="nopan nodrag flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded-full border border-[var(--frameLine)] bg-[var(--chip)] text-[var(--muted)] outline-none hover:border-[#c94c27] hover:text-[#c94c27] focus-visible:border-[#c94c27] focus-visible:text-[#c94c27]"
          onClick={() => edit.remove(id)}
        >
          <Icons.X aria-hidden size={11} />
        </button>
      )}
    </div>
  );
});

/** How far along the curve (in flow px) an end's grab handle sits from the port it ends at. */
const END_HANDLE_OFFSET = 20;

/** A point on the theme's curve (`edgePath`) at parameter `t`. */
function pointOnEdge(x1: number, y1: number, x2: number, y2: number, t: number): Point {
  const dx = Math.max(50, Math.abs(x2 - x1) * 0.5);
  const c1x = x1 + dx;
  const c2x = x2 - dx;
  const u = 1 - t;
  return {
    x: u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2,
    y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2,
  };
}

/**
 * The grab handle on one end of a hovered or selected data edge (FR-CON-001): a press starts moving
 * that end. It sits a little along the curve from the port, never on it, so the port itself still
 * starts a new connection.
 */
function EdgeEndHandle({
  id,
  end,
  at,
  dragging,
  edit,
}: {
  id: string;
  end: EdgeEnd;
  at: Point;
  dragging: boolean;
  edit: EdgeEditApi;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-testid={`edge-end-${end}-${id}`}
      aria-label={
        end === 'source' ? 'Move the start of this connection' : 'Move the end of this connection'
      }
      title={
        end === 'source'
          ? 'Drag to move where this connection starts'
          : 'Drag to move where this connection ends'
      }
      className={cn(
        'nopan nodrag absolute h-[14px] w-[14px] rounded-full border-2 border-[#ef6b3f] bg-[var(--canvas)] p-0 shadow-[0_0_0_3px_rgba(239,107,63,0.18)]',
        // while dragged it follows the pointer and must not hide what is under it from the drop
        dragging ? 'pointer-events-none cursor-grabbing' : 'pointer-events-auto cursor-grab',
      )}
      style={{ left: at.x, top: at.y, transform: 'translate(-50%,-50%)' }}
      onMouseEnter={() => edit.hover(id)}
      onMouseLeave={() => edit.hover(undefined)}
      onPointerDown={(event) => {
        event.stopPropagation();
        edit.startReconnect(id, end, event);
      }}
    />
  );
}

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
 * D350: the ports shown above the edge layer — while a line is drawn, every candidate (dimmed when
 * it would be refused); otherwise the selected cards' and an armed one. A hovered card's ports
 * show through its handles (theme.css): tracking the pointer in React cost the 200-node pan its
 * frame budget (TC-NFR-001).
 */
export function shownPorts(
  nodes: readonly Node[],
  connectStates: ReadonlyMap<string, PortConnectState> | undefined,
  selectedNodeIds: readonly string[],
  armedPortId: string | undefined,
): Map<string, PortDotLook> {
  const shown = new Map<string, PortDotLook>();
  if (connectStates !== undefined) {
    for (const [portId, state] of connectStates) {
      shown.set(portId, state.look === 'incompatible' ? 'dim' : 'on');
    }
    return shown;
  }
  const lit = new Set(selectedNodeIds);
  for (const node of nodes) {
    if (!lit.has(node.id)) continue;
    for (const port of [...node.inputs, ...node.outputs]) shown.set(port.id, 'on');
  }
  if (armedPortId !== undefined) shown.set(armedPortId, 'on');
  return shown;
}

/**
 * PG-1.1 (D350): ports sit above the edge layer. The edges are drawn over the nodes (D332), so a
 * port's own handle — inside its card — would sit under any edge crossing it; this layer repeats
 * each shown port's dot just above the edges, at the same anchor and in the same colour. It touches
 * no pointer: the handle underneath still takes the press.
 */
export const PortDotLayer = memo(function PortDotLayer({
  nodes,
  connectStates,
  selectedNodeIds,
  armedPortId,
}: {
  nodes: readonly Node[];
  /** While a line is drawn: every candidate port, compatible or not (D350). */
  connectStates: ReadonlyMap<string, PortConnectState> | undefined;
  selectedNodeIds: readonly string[];
  armedPortId: string | undefined;
}) {
  const shown = useMemo(
    () => shownPorts(nodes, connectStates, selectedNodeIds, armedPortId),
    [nodes, connectStates, selectedNodeIds, armedPortId],
  );
  // nothing shown: nothing subscribed to the store either (TC-NFR-001)
  return shown.size === 0 ? null : <PortDots nodes={nodes} shown={shown} />;
});

function PortDots({
  nodes,
  shown,
}: {
  nodes: readonly Node[];
  shown: ReadonlyMap<string, PortDotLook>;
}) {
  const live = useStore(selectNodes);
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
}

/**
 * Every edge's look, drawn above the nodes as the theme draws them (D332). It lives in React Flow's
 * viewport portal — after the node layer, in the same pan and zoom. The lines touch no pointer:
 * React Flow's own (invisible) edges take the clicks. With `edit`, a data edge's chip is the type
 * dropdown and its ✕, and a hovered or selected data edge shows a grab handle on each end
 * (FR-CON-001/004/006); loop edges keep their own chip and menu (FR-CON-007). The anchors are the
 * ports' theme anchors on the nodes' live positions from React Flow's store, so an edge follows a
 * node while it is dragged.
 */
export const EdgeLayer = memo(function EdgeLayer({
  nodes,
  edges,
  edit,
  hoveredEdgeId,
  reconnect,
}: {
  /** The contract nodes: kinds and port order decide each anchor. */
  nodes: readonly Node[];
  /** The edges React Flow is drawing, with their selection and live loop data. */
  edges: readonly AceAnyFlowEdge[];
  /** Absent (read-only): the chips are plain labels and no end can be moved. */
  edit?: EdgeEditApi | undefined;
  hoveredEdgeId?: string | undefined;
  /** An end being dragged to a new port: drawn at the pointer. */
  reconnect?: EdgeReconnectDrag | undefined;
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
    const moving = reconnect?.edgeId === edge.id ? reconnect : undefined;
    const x1 = moving?.end === 'source' ? moving.x : from.x + a.x;
    const y1 = moving?.end === 'source' ? moving.y : from.y + a.y;
    const x2 = moving?.end === 'target' ? moving.x : to.x + b.x;
    const y2 = moving?.end === 'target' ? moving.y : to.y + b.y;
    const ghost = edge.className === GHOST_EDGE_CLASS;
    return [
      {
        id: edge.id,
        x1,
        y1,
        x2,
        y2,
        selected: edge.selected === true || moving !== undefined,
        ghost,
        editable: edit !== undefined && !ghost && label.kind === 'data',
        moving,
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
          {drawn.map(({ id, d, x1, y1, x2, y2, selected, ghost }) => (
            <EdgeStroke
              key={id}
              id={id}
              d={d}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              selected={selected}
              ghost={ghost}
            />
          ))}
        </svg>
        {drawn.map(({ id, mx, my, label, editable, selected }) =>
          editable && edit !== undefined && label.kind === 'data' ? (
            <EdgeTypeChip
              key={id}
              id={id}
              mx={mx}
              my={my}
              dataType={label.dataType}
              active={selected || hoveredEdgeId === id}
              selected={selected}
              edit={edit}
            />
          ) : (
            <EdgeChip key={id} id={id} mx={mx} my={my} label={label} />
          ),
        )}
        {edit !== undefined &&
          drawn.flatMap(({ id, x1, y1, x2, y2, editable, selected, moving }) => {
            if (!editable || !(selected || hoveredEdgeId === id || moving)) return [];
            const length = Math.hypot(x2 - x1, y2 - y1) + 100;
            const t = Math.min(0.3, END_HANDLE_OFFSET / length);
            const start =
              moving?.end === 'source' ? { x: x1, y: y1 } : pointOnEdge(x1, y1, x2, y2, t);
            const finish =
              moving?.end === 'target' ? { x: x2, y: y2 } : pointOnEdge(x1, y1, x2, y2, 1 - t);
            return [
              <EdgeEndHandle
                key={`${id}:source`}
                id={id}
                end="source"
                at={start}
                dragging={moving !== undefined}
                edit={edit}
              />,
              <EdgeEndHandle
                key={`${id}:target`}
                id={id}
                end="target"
                at={finish}
                dragging={moving !== undefined}
                edit={edit}
              />,
            ];
          })}
      </div>
    </ViewportPortal>
  );
});
