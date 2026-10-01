import type { Edge } from '@ace/contracts';

import { NODE_SLOT } from '../placement';
import { autoLayout, type LayoutNode } from './auto-layout';

const node = (id: string, x = 0, y = 0, width?: number, height?: number): LayoutNode => ({
  id,
  position: { x, y },
  ...(width === undefined ? {} : { width }),
  ...(height === undefined ? {} : { height }),
});

const edge = (id: string, from: string, to: string, kind: 'data' | 'loop' = 'data'): Edge =>
  ({
    id,
    workflowId: 'w',
    kind,
    from: { nodeId: from, portId: `${from}:out:text` },
    to: { nodeId: to, portId: `${to}:in:text` },
  }) as Edge;

type Box = { x: number; y: number; w: number; h: number };

function boxes(nodes: LayoutNode[], positions: Map<string, { x: number; y: number }>): Box[] {
  return nodes.map((n) => {
    const p = positions.get(n.id)!;
    return { x: p.x, y: p.y, w: n.width ?? NODE_SLOT.width, h: n.height ?? NODE_SLOT.height };
  });
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('TC-CAN-007 auto-layout (FR-CAN-008, ADR-010)', () => {
  // A scattered six-node graph: two inputs → agent → (model, transform) → output, all on top of each other.
  const nodes = [
    node('out', 10, 10, 180, 90),
    node('in1', 12, 14, 180, 90),
    node('agent', 5, 5, 200, 120),
    node('model', 8, 8, 180, 90),
    node('xf', 11, 11, 180, 90),
    node('in2', 9, 9, 180, 90),
  ];
  const edges = [
    edge('e1', 'in1', 'agent'),
    edge('e2', 'in2', 'agent'),
    edge('e3', 'agent', 'model'),
    edge('e4', 'agent', 'xf'),
    edge('e5', 'model', 'out'),
    edge('e6', 'xf', 'out'),
  ];

  it('leaves no two bounding boxes overlapping', () => {
    const laid = autoLayout(nodes, edges);
    const all = boxes(nodes, laid);
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        expect(overlap(all[i]!, all[j]!)).toBe(false);
      }
    }
  });

  it('puts every data edge left to right: the source ends before the target starts', () => {
    const laid = autoLayout(nodes, edges);
    for (const e of edges) {
      const from = nodes.find((n) => n.id === e.from.nodeId)!;
      expect(laid.get(e.from.nodeId)!.x + (from.width ?? 0)).toBeLessThan(laid.get(e.to.nodeId)!.x);
    }
  });

  it('is deterministic: same input, same output, whatever order the nodes arrive in', () => {
    const a = autoLayout(nodes, edges);
    const b = autoLayout([...nodes].reverse(), [...edges].reverse());
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
  });

  it('ignores loop edges for layering (FR-CON-007): a loop back does not push its target right', () => {
    const chain = [node('a', 0, 0, 180, 90), node('b', 0, 0, 180, 90)];
    const laid = autoLayout(chain, [edge('d', 'a', 'b'), edge('l', 'b', 'a', 'loop')]);
    expect(laid.get('a')!.x).toBeLessThan(laid.get('b')!.x);
  });

  it('survives a data cycle without hanging and still lays every node out', () => {
    const ring = [node('a'), node('b'), node('c')];
    const laid = autoLayout(ring, [edge('1', 'a', 'b'), edge('2', 'b', 'c'), edge('3', 'c', 'a')]);
    expect(laid.size).toBe(3);
    const all = boxes(ring, laid);
    expect(overlap(all[0]!, all[1]!) || overlap(all[1]!, all[2]!)).toBe(false);
  });

  it('lays out disconnected nodes too, without overlaps, using NODE_SLOT when unmeasured', () => {
    const loose = [node('x', 0, 0), node('y', 0, 0), node('z', 0, 0)];
    const laid = autoLayout(loose, []);
    expect(laid.size).toBe(3);
    const all = boxes(loose, laid);
    expect(overlap(all[0]!, all[1]!)).toBe(false);
    expect(overlap(all[1]!, all[2]!)).toBe(false);
    expect(overlap(all[0]!, all[2]!)).toBe(false);
  });

  it('anchors the layout at the top-left of the current graph and returns whole numbers', () => {
    const laid = autoLayout([node('a', 300.4, 200.6), node('b', 900, 50)], [edge('e', 'a', 'b')]);
    expect(laid.get('a')).toEqual({ x: 300, y: 50 });
    for (const p of laid.values()) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
  });

  it('returns an empty map for an empty graph', () => {
    expect(autoLayout([], []).size).toBe(0);
  });
});
