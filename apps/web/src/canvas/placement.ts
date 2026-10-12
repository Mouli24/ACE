import type { Position } from '@ace/contracts';

/**
 * The space one node card occupies on the Canvas, plus the gap that keeps two cards from
 * touching. The largest card is the theme's 210 × 280 stage frame (D332), whose label chip and
 * badge stand 9 px outside it; the slot leaves 50 px either way so ports on neighbouring cards stay
 * separately clickable (FR-CAN-002, NFR-USE-01).
 */
export const NODE_SLOT = { width: 260, height: 330 } as const;

/** The visible part of the Canvas in flow coordinates. */
export interface VisibleArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Positioned {
  position: Position;
}

const overlaps = (a: Position, b: Position): boolean =>
  Math.abs(a.x - b.x) < NODE_SLOT.width && Math.abs(a.y - b.y) < NODE_SLOT.height;

const free = (candidate: Position, nodes: readonly Positioned[]): boolean =>
  !nodes.some((node) => overlaps(candidate, node.position));

const round = (p: Position): Position => ({ x: Math.round(p.x), y: Math.round(p.y) });

/**
 * Where a node added from the palette should go: `preferred` when that spot is free, otherwise
 * the first free slot of a grid laid over the visible area — so a new node never lands on top of
 * another (its ports would be unreachable) and never lands off-screen (it would not be rendered).
 * Only when the whole visible area is full does it march to the right of `preferred`.
 */
export function freeSlotNear(
  nodes: readonly Positioned[],
  preferred: Position,
  visible?: VisibleArea,
): Position {
  if (free(preferred, nodes)) return round(preferred);

  if (visible) {
    const columns = Math.max(1, Math.floor(visible.width / NODE_SLOT.width));
    const rows = Math.max(1, Math.floor(visible.height / NODE_SLOT.height));
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const candidate = {
          x: visible.x + 40 + column * NODE_SLOT.width,
          y: visible.y + 40 + row * NODE_SLOT.height,
        };
        if (free(candidate, nodes)) return round(candidate);
      }
    }
  }

  for (let step = 1; step <= nodes.length + 1; step += 1) {
    const candidate = { x: preferred.x + step * NODE_SLOT.width, y: preferred.y };
    if (free(candidate, nodes)) return round(candidate);
  }
  return round(preferred);
}
