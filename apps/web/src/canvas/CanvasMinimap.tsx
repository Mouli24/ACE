import { useReactFlow, useStore, useViewport, type ReactFlowState } from '@xyflow/react';
import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';

import { cardSize, isStageKind } from '../nodes/anchors';
import type { AceFlowNode } from '../nodes/NodeCard';
import { th, themeProviderOf } from '../theme/constants';
import {
  MINI_H,
  MINI_PAD,
  MINI_W,
  bounds,
  miniGeo,
  miniJump,
  minimapFits,
  type Rect,
} from './viewport';

const selectNodes = (state: ReactFlowState) => state.nodes as AceFlowNode[];
const selectWidth = (state: ReactFlowState) => state.width;
const selectHeight = (state: ReactFlowState) => state.height;

/** A node's world rect, from React Flow's node (measured where it has been). */
export function rectOf(node: AceFlowNode): Rect {
  const size = cardSize(node.data.node.kind, node.measured);
  return { x: node.position.x, y: node.position.y, w: size.w, h: size.h };
}

/**
 * The theme's minimap (D332), bottom-right: every node scaled into 160 × 104 (stages in their
 * provider's colour, white for a white look; document cards in `--iconLine`) and the visible area
 * as an orange frame. A press or a drag on it centres the view on that point (`miniJump`).
 * Hidden, not unmounted, on a Canvas too narrow to hold it beside the toolbar (`minimapFits`).
 */
export function CanvasMinimap({ dark }: { dark: boolean }) {
  const flow = useReactFlow();
  const view = useViewport();
  const nodes = useStore(selectNodes);
  const cw = useStore(selectWidth);
  const ch = useStore(selectHeight);
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const rects = nodes.map(rectOf);
  const geo = miniGeo(bounds(rects), view, cw, ch);

  /** The theme's `miniJump(e)`, against the view as it is at this moment. */
  const jump = (clientX: number, clientY: number) => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const now = flow.getViewport();
    const g = miniGeo(bounds(flow.getNodes().map((n) => rectOf(n as AceFlowNode))), now, cw, ch);
    void flow.setViewport(
      miniJump(now, g, clientX - r.left - MINI_PAD, clientY - r.top - MINI_PAD, cw, ch),
    );
  };
  const jumpRef = useRef(jump);
  jumpRef.current = jump;

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      if (dragging.current) jumpRef.current(event.clientX, event.clientY);
    };
    const onUp = () => {
      dragging.current = false;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onMouseDown = (event: ReactMouseEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    dragging.current = true;
    jump(event.clientX, event.clientY);
  };

  const [vl, vt] = geo.map(geo.v.x0, geo.v.y0);
  return (
    <div
      ref={box}
      data-testid="canvas-minimap"
      hidden={!minimapFits(cw)}
      onMouseDown={onMouseDown}
      className="absolute bottom-[16px] right-[16px] z-[5] h-[116px] w-[172px] cursor-pointer rounded-[10px] border border-[var(--line)] bg-[var(--surface)] p-[6px] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]"
    >
      <div className="absolute left-[9px] top-[6px] font-machine text-[8px] tracking-[0.1em] text-[var(--muted)]">
        MAP
      </div>
      <div className="relative" style={{ width: MINI_W, height: MINI_H }}>
        {nodes.map((node, i) => {
          const rect = rects[i] as Rect;
          const [l, t] = geo.map(rect.x, rect.y);
          const kind = node.data.node.kind;
          let colour = 'var(--iconLine)';
          if (isStageKind(kind)) {
            const look = th(themeProviderOf(node.data.provider), dark);
            colour = look.w ? '#ffffff' : look.c;
          }
          return (
            <div
              key={node.id}
              data-testid={`minimap-node-${node.id}`}
              className="absolute rounded-[2px]"
              style={{
                left: l,
                top: t,
                width: Math.max(3, rect.w * geo.k),
                height: Math.max(3, rect.h * geo.k),
                background: colour,
              }}
            />
          );
        })}
        <div
          data-testid="minimap-view"
          className="absolute rounded-[3px] border-[1.5px] border-solid border-[#ef6b3f] bg-[rgba(239,107,63,0.06)]"
          style={{
            left: vl,
            top: vt,
            width: (geo.v.x1 - geo.v.x0) * geo.k,
            height: (geo.v.y1 - geo.v.y0) * geo.k,
          }}
        />
      </div>
    </div>
  );
}
