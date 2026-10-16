import type { Node, NodeKind } from '@ace/contracts';

/*
 * Where things sit on a node card (D332): the theme's card sizes (`SZ`) and the anchor points its
 * edges start and end at, which is also where each port's invisible React Flow handle is placed.
 * Offsets are from the card's top-left corner (its border box), the theme's `pos`.
 */

/** Agent and Model nodes are the theme's Stage cards; every other kind is a Document card. */
export const isStageKind = (kind: NodeKind): boolean => kind === 'agent' || kind === 'model';

/** The theme's stage frame: 210 × 280. */
export const STAGE_W = 210;
export const STAGE_H = 280;
/** The theme's document card: 200 wide; 170 tall is its `SZ` entry, used until measured. */
export const DOC_W = 200;
export const DOC_H = 170;

/**
 * Anchors. A stage card's ports sit on its left and right edges at mid-height (D371: the theme put
 * them on the small icon circle, `(77, 118)` / `(133, 118)`, where nobody found them); a document
 * card's in `(0, 44)`, out `(200, 44)`.
 */
const STAGE_IN = { x: 0, y: STAGE_H / 2 } as const;
const STAGE_OUT = { x: STAGE_W, y: STAGE_H / 2 } as const;
const DOC_IN = { x: 0, y: 44 } as const;
const DOC_OUT = { x: DOC_W, y: 44 } as const;

/** Several ports on one side stack 16 px apart, centred on the side's anchor. */
export const PORT_GAP = 16;
/**
 * …but never above this line: a document card's anchor is 44 px down, so a tall stack (an Output
 * node has an input per data type) starts 12 px below the card's top instead of above the card.
 */
const PORT_TOP = 12;

export interface Point {
  x: number;
  y: number;
}

/** The anchor of port `index` of `count` on one side of a card of this kind. */
export function portAnchor(
  kind: NodeKind,
  direction: 'in' | 'out',
  index: number,
  count: number,
): Point {
  const stage = isStageKind(kind);
  const base = direction === 'in' ? (stage ? STAGE_IN : DOC_IN) : stage ? STAGE_OUT : DOC_OUT;
  const top = Math.max(PORT_TOP, base.y - ((count - 1) / 2) * PORT_GAP);
  return { x: base.x, y: top + index * PORT_GAP };
}

/** A port's anchor on its node, or undefined for a port the node does not have. */
export function anchorOfPort(node: Node, portId: string): Point | undefined {
  const outIndex = node.outputs.findIndex((port) => port.id === portId);
  if (outIndex >= 0) return portAnchor(node.kind, 'out', outIndex, node.outputs.length);
  const inIndex = node.inputs.findIndex((port) => port.id === portId);
  if (inIndex >= 0) return portAnchor(node.kind, 'in', inIndex, node.inputs.length);
  return undefined;
}

/** A card's size: what React Flow measured, else the theme's `SZ` for its kind. */
export function cardSize(
  kind: NodeKind,
  measured?: { width?: number | undefined; height?: number | undefined },
): { w: number; h: number } {
  if (isStageKind(kind)) return { w: STAGE_W, h: STAGE_H };
  return { w: measured?.width || DOC_W, h: measured?.height || DOC_H };
}
