import { NODE_SLOT, freeSlotNear, type VisibleArea } from './placement';

const at = (x: number, y: number) => ({ position: { x, y } });
const visible: VisibleArea = { x: 0, y: 0, width: 1200, height: 700 };

describe('freeSlotNear (FR-CAN-002: a node from the palette must be visible and reachable)', () => {
  it('uses the requested spot when nothing is there', () => {
    expect(freeSlotNear([], { x: 100, y: 100 }, visible)).toEqual({ x: 100, y: 100 });
  });

  it('never returns a spot that overlaps an existing card', () => {
    const existing = [at(40, 40), at(300, 40), at(560, 40)];
    const slot = freeSlotNear(existing, { x: 40, y: 40 }, visible);
    for (const node of existing) {
      const clash =
        Math.abs(slot.x - node.position.x) < NODE_SLOT.width &&
        Math.abs(slot.y - node.position.y) < NODE_SLOT.height;
      expect(clash).toBe(false);
    }
  });

  it('keeps every node inside the visible area while there is room', () => {
    const placed: Array<{ position: { x: number; y: number } }> = [];
    for (let i = 0; i < 8; i += 1) {
      const slot = freeSlotNear(placed, { x: 600, y: 350 }, visible);
      placed.push({ position: slot });
      expect(slot.x).toBeGreaterThanOrEqual(visible.x);
      expect(slot.x).toBeLessThanOrEqual(visible.x + visible.width);
      expect(slot.y).toBeGreaterThanOrEqual(visible.y);
      expect(slot.y).toBeLessThanOrEqual(visible.y + visible.height);
    }
    const keys = new Set(placed.map((n) => `${n.position.x}:${n.position.y}`));
    expect(keys.size).toBe(placed.length);
  });

  it('falls back to marching right when the visible area is full', () => {
    const tiny: VisibleArea = { x: 0, y: 0, width: 300, height: 200 };
    const placed = [at(40, 40)];
    const slot = freeSlotNear(placed, { x: 40, y: 40 }, tiny);
    expect(slot.x).toBeGreaterThanOrEqual(40 + NODE_SLOT.width);
  });

  it('works without a visible area and rounds to whole pixels', () => {
    const slot = freeSlotNear([at(10, -3)], { x: 10.6, y: -3.2 });
    expect(Number.isInteger(slot.x)).toBe(true);
    expect(Number.isInteger(slot.y)).toBe(true);
  });
});
