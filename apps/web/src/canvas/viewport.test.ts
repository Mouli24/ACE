import {
  FIT_ZOOM_MAX,
  ZOOM_MAX,
  ZOOM_MIN,
  bounds,
  centreOn,
  edgePath,
  fitView,
  MINI_MIN_CANVAS_W,
  miniGeo,
  miniJump,
  minimapFits,
  wheelView,
  zoomAt,
} from './viewport';

/*
 * The theme's viewport maths (D332), checked against hand-worked numbers from
 * `Ace Canvas.dc.html`'s `zoomAt`, `fit`, `miniGeo`, `miniJump` and `addNode`.
 */

describe('zoomAt: the point under the cursor stays put', () => {
  it('scales about the point', () => {
    const view = zoomAt({ x: 40, y: 40, zoom: 1 }, 2, 100, 60);
    expect(view).toEqual({ zoom: 2, x: 100 - (100 - 40) * 2, y: 60 - (60 - 40) * 2 });
    // the world point that was under (100, 60) still is
    const before = { x: (100 - 40) / 1, y: (60 - 40) / 1 };
    expect((100 - view.x) / view.zoom).toBeCloseTo(before.x);
    expect((60 - view.y) / view.zoom).toBeCloseTo(before.y);
  });

  it('clamps to 0.25–2.5 and scales the pan by the clamped ratio', () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 2 }, 10, 0, 0).zoom).toBe(ZOOM_MAX);
    expect(zoomAt({ x: 0, y: 0, zoom: 0.5 }, 0.1, 0, 0).zoom).toBe(ZOOM_MIN);
    const view = zoomAt({ x: 10, y: 10, zoom: 2 }, 10, 0, 0);
    expect(view.x).toBeCloseTo(10 * (2.5 / 2));
  });
});

describe('wheelView: Ctrl/⌘ zooms at the cursor, a plain wheel pans', () => {
  it('a plain wheel pans by −deltaX, −deltaY', () => {
    expect(
      wheelView(
        { x: 5, y: 5, zoom: 1.5 },
        { deltaX: 10, deltaY: -20, ctrlKey: false, metaKey: false },
        0,
        0,
      ),
    ).toEqual({ x: -5, y: 25, zoom: 1.5 });
  });

  it('Ctrl or ⌘ zooms by exp(−deltaY·0.01) at the cursor', () => {
    const start = { x: 0, y: 0, zoom: 1 };
    const ctrl = wheelView(
      start,
      { deltaX: 0, deltaY: -50, ctrlKey: true, metaKey: false },
      200,
      100,
    );
    expect(ctrl.zoom).toBeCloseTo(Math.exp(0.5));
    expect(ctrl).toEqual(zoomAt(start, Math.exp(0.5), 200, 100));
    const meta = wheelView(
      start,
      { deltaX: 0, deltaY: 50, ctrlKey: false, metaKey: true },
      200,
      100,
    );
    expect(meta.zoom).toBeCloseTo(Math.exp(-0.5));
  });
});

describe('bounds and fit', () => {
  it('bounds is the box around every rect; nothing for no rects', () => {
    expect(
      bounds([
        { x: 440, y: 150, w: 210, h: 280 },
        { x: 90, y: 380, w: 200, h: 170 },
      ]),
    ).toEqual({ x0: 90, y0: 150, x1: 650, y1: 550 });
    expect(bounds([])).toBeUndefined();
  });

  it('fit centres the box padded 80, zoom from the tighter axis', () => {
    const box = { x0: 0, y0: 0, x1: 1000, y1: 400 };
    const view = fitView(box, 1160, 760);
    // (1160 − 160) / 1000 = 1, (760 − 160) / 400 = 1.5 → 1
    expect(view.zoom).toBe(1);
    expect(view.x).toBe((1160 - 1000) / 2);
    expect(view.y).toBe((760 - 400) / 2);
  });

  it('fit never zooms past 1.4 or below 0.25', () => {
    expect(fitView({ x0: 0, y0: 0, x1: 10, y1: 10 }, 1000, 800).zoom).toBe(FIT_ZOOM_MAX);
    expect(fitView({ x0: 0, y0: 0, x1: 100000, y1: 10 }, 1000, 800).zoom).toBe(ZOOM_MIN);
  });
});

describe('centreOn: Add node centres the view on the new stage', () => {
  it('pans so the world point lands on the canvas centre, keeping the zoom', () => {
    const view = centreOn({ x: 0, y: 0, zoom: 0.5 }, 760 + 105, 200 + 140, 1000, 600);
    expect(view).toEqual({ zoom: 0.5, x: 500 - 865 * 0.5, y: 300 - 340 * 0.5 });
  });
});

describe('miniGeo and miniJump: the minimap', () => {
  const view = { x: 0, y: 0, zoom: 1 };

  it('is hidden on a Canvas too narrow to hold it clear of the toolbar', () => {
    // toolbar 18 + 234, minimap 172 + 16: they would touch at 440
    expect(MINI_MIN_CANVAS_W).toBeGreaterThan(18 + 234 + 172 + 16);
    expect(minimapFits(940)).toBe(true);
    expect(minimapFits(MINI_MIN_CANVAS_W)).toBe(true);
    expect(minimapFits(MINI_MIN_CANVAS_W - 1)).toBe(false);
    expect(minimapFits(380)).toBe(false);
    // not measured yet: shown, as before React Flow knew its size
    expect(minimapFits(0)).toBe(true);
  });

  it('fits the nodes and the visible area, 40 units of margin, into 160 × 104', () => {
    const geo = miniGeo({ x0: 0, y0: 0, x1: 1000, y1: 500 }, view, 1000, 600);
    expect(Object.values(geo.v).map((n) => n + 0)).toEqual([0, 0, 1000, 600]);
    // world box −40…1040 × −40…640: k = min(160/1080, 104/680)
    expect(geo.k).toBeCloseTo(Math.min(160 / 1080, 104 / 680));
    const [mx, my] = geo.map(500, 300);
    const [wx, wy] = geo.unmap(mx, my);
    expect(wx).toBeCloseTo(500);
    expect(wy).toBeCloseTo(300);
  });

  it('a jump centres the canvas on the world point under the pointer', () => {
    const geo = miniGeo({ x0: 0, y0: 0, x1: 1000, y1: 500 }, view, 1000, 600);
    const [mx, my] = geo.map(800, 100);
    const next = miniJump(view, geo, mx, my, 1000, 600);
    expect(next.zoom).toBe(1);
    expect(next.x).toBeCloseTo(500 - 800);
    expect(next.y).toBeCloseTo(300 - 100);
  });

  it('with no nodes it maps the visible area alone', () => {
    const geo = miniGeo(undefined, view, 800, 400);
    expect(Number.isFinite(geo.k)).toBe(true);
  });
});

describe('edgePath: the theme’s cubic and its midpoint', () => {
  it('handles run horizontally by max(50, |Δx|·½)', () => {
    expect(edgePath(0, 0, 400, 100).d).toBe('M0 0 C200 0 200 100 400 100');
    expect(edgePath(0, 0, 40, 100).d).toBe('M0 0 C50 0 -10 100 40 100');
  });

  it('puts the label at t = ½', () => {
    const { mx, my } = edgePath(0, 0, 400, 100);
    expect(mx).toBe(200);
    expect(my).toBe(50);
  });
});
