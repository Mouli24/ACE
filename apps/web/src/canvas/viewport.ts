/*
 * The Ace UI theme's viewport maths (D332), ported from `Ace Canvas.dc.html`'s `zoomAt`, `bounds`,
 * `fit`, `miniGeo`, `miniJump` and `addNode`. Pure functions over React Flow's `{x, y, zoom}`
 * viewport (the theme's `pan` and `z`), so the Canvas hands them to `setViewport` and the tests can
 * check the numbers without a layout engine.
 */

/** React Flow's viewport: `x`/`y` are the theme's `pan`, `zoom` its `z`. */
export interface View {
  x: number;
  y: number;
  zoom: number;
}

/** A world-space box: left, top, right, bottom. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A node's rect in world space. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2.5;
/** The toolbar's + and − (`zoomAt(1.2, …)` at the centre). */
export const ZOOM_STEP = 1.2;
/** `fit()`: padding around the nodes, and the largest zoom it will choose. */
export const FIT_PAD = 80;
export const FIT_ZOOM_MAX = 1.4;
/** The minimap's drawing area inside its 6px padding. */
export const MINI_W = 160;
export const MINI_H = 104;
/** `miniJump` measures from the minimap's box minus this padding. */
export const MINI_PAD = 6;
/**
 * The narrowest Canvas the minimap is shown on. It takes 188px from the right (172 + 16) and the
 * toolbar ends 252px from the left (18 + 234 while editing); below this the minimap would cover
 * the toolbar's Fit to view, so it is hidden.
 */
export const MINI_MIN_CANVAS_W = 460;

/** Whether a Canvas `cw` wide has room for the minimap; an unmeasured (0-wide) one shows it. */
export const minimapFits = (cw: number): boolean => cw === 0 || cw >= MINI_MIN_CANVAS_W;

export const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** The theme's `zoomAt(f, cx, cy)`: scale by `f` (clamped), keeping the point under `cx, cy` still. */
export function zoomAt(view: View, f: number, cx: number, cy: number): View {
  const zoom = clampZoom(view.zoom * f);
  const k = zoom / view.zoom;
  return { zoom, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
}

/** The bits of a wheel event the theme reads. */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * The theme's wheel handler: Ctrl/⌘ zooms at the cursor by `exp(-deltaY·0.01)`, anything else pans
 * by the wheel's deltas. `cx, cy` is the cursor relative to the canvas.
 */
export function wheelView(view: View, event: WheelLike, cx: number, cy: number): View {
  if (event.ctrlKey || event.metaKey) return zoomAt(view, Math.exp(-event.deltaY * 0.01), cx, cy);
  return { ...view, x: view.x - event.deltaX, y: view.y - event.deltaY };
}

/** The theme's `bounds()`: the box around every rect; undefined with no rects. */
export function bounds(rects: readonly Rect[]): Box | undefined {
  if (rects.length === 0) return undefined;
  let x0 = 1e9;
  let y0 = 1e9;
  let x1 = -1e9;
  let y1 = -1e9;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x0, y0, x1, y1 };
}

/** The theme's `fit()`: the box centred in a `cw × ch` canvas, padded 80, zoom 0.25–1.4. */
export function fitView(b: Box, cw: number, ch: number): View {
  const zoom = Math.min(
    FIT_ZOOM_MAX,
    Math.max(
      ZOOM_MIN,
      Math.min((cw - FIT_PAD * 2) / (b.x1 - b.x0), (ch - FIT_PAD * 2) / (b.y1 - b.y0)),
    ),
  );
  return {
    zoom,
    x: (cw - (b.x1 - b.x0) * zoom) / 2 - b.x0 * zoom,
    y: (ch - (b.y1 - b.y0) * zoom) / 2 - b.y0 * zoom,
  };
}

/** The pan that puts world point `wx, wy` at the centre of the canvas (`addNode`, `miniJump`). */
export function centreOn(view: View, wx: number, wy: number, cw: number, ch: number): View {
  return { zoom: view.zoom, x: cw / 2 - wx * view.zoom, y: ch / 2 - wy * view.zoom };
}

export interface MiniGeo {
  /** World units → minimap pixels. */
  k: number;
  map(x: number, y: number): [number, number];
  unmap(mx: number, my: number): [number, number];
  /** The visible part of the world. */
  v: Box;
}

/**
 * The theme's `miniGeo()`: the minimap shows the nodes and the visible area together, 40 world
 * units of margin around both, scaled to fit 160×104 and centred.
 */
export function miniGeo(b: Box | undefined, view: View, cw: number, ch: number): MiniGeo {
  const v: Box = {
    x0: -view.x / view.zoom,
    y0: -view.y / view.zoom,
    x1: (cw - view.x) / view.zoom,
    y1: (ch - view.y) / view.zoom,
  };
  const all = b ?? v;
  const x0 = Math.min(all.x0, v.x0) - 40;
  const y0 = Math.min(all.y0, v.y0) - 40;
  const x1 = Math.max(all.x1, v.x1) + 40;
  const y1 = Math.max(all.y1, v.y1) + 40;
  const k = Math.min(MINI_W / (x1 - x0), MINI_H / (y1 - y0));
  const ox = (MINI_W - (x1 - x0) * k) / 2;
  const oy = (MINI_H - (y1 - y0) * k) / 2;
  return {
    k,
    map: (x, y) => [ox + (x - x0) * k, oy + (y - y0) * k],
    unmap: (mx, my) => [(mx - ox) / k + x0, (my - oy) / k + y0],
    v,
  };
}

/**
 * The theme's `miniJump(e)`: the world point under the pointer (`mx, my` measured from the
 * minimap's box less its 6px padding) becomes the centre of the canvas.
 */
export function miniJump(
  view: View,
  geo: MiniGeo,
  mx: number,
  my: number,
  cw: number,
  ch: number,
): View {
  const [wx, wy] = geo.unmap(mx, my);
  return centreOn(view, wx, wy, cw, ch);
}

/**
 * An edge as the theme draws it: a cubic from the out-anchor to the in-anchor, both handles
 * horizontal, `dx = max(50, |x2 − x1|·0.5)`, and its label at the curve's midpoint (t = ½).
 */
export function edgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { d: string; mx: number; my: number } {
  const dx = Math.max(50, Math.abs(x2 - x1) * 0.5);
  const c1x = x1 + dx;
  const c2x = x2 - dx;
  return {
    d: `M${x1} ${y1} C${c1x} ${y1} ${c2x} ${y2} ${x2} ${y2}`,
    mx: (x1 + 3 * c1x + 3 * c2x + x2) / 8,
    my: (y1 + 3 * y1 + 3 * y2 + y2) / 8,
  };
}
