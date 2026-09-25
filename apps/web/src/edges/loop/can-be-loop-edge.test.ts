import { portId, type Edge, type LoopGraph, type Port } from '@ace/contracts';

import { canBeLoopEdge } from './can-be-loop-edge';

const jsonOut = (nodeId: string): Port => ({
  id: portId(nodeId, 'out', 'json'),
  name: 'json',
  dataType: 'json',
  multi: true,
});

const node = (id: string, json = true): LoopGraph['nodes'][number] => ({
  id,
  name: id.toUpperCase(),
  outputs: json ? [jsonOut(id)] : [],
});

const dataEdge = (from: string, to: string): LoopGraph['edges'][number] => ({
  id: `e-${from}-${to}`,
  kind: 'data',
  from: { nodeId: from, portId: portId(from, 'out', 'json') },
  to: { nodeId: to, portId: portId(to, 'in', 'json') },
});

const candidate = (from: string, to: string): Pick<Edge, 'id' | 'from' | 'to'> => ({
  id: 'candidate',
  from: { nodeId: from, portId: portId(from, 'out', 'json') },
  to: { nodeId: to, portId: portId(to, 'in', 'json') },
});

describe('canBeLoopEdge (FR-CON-007)', () => {
  describe('a chain a → b → c', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [dataEdge('a', 'b'), dataEdge('b', 'c')];

    it('allows an edge back to a node upstream of its source', () => {
      expect(canBeLoopEdge(candidate('c', 'a'), nodes, edges)).toEqual({ ok: true });
      expect(canBeLoopEdge(candidate('c', 'b'), nodes, edges)).toEqual({ ok: true });
    });

    it('refuses an edge that runs the way the data already runs', () => {
      const check = canBeLoopEdge(candidate('a', 'c'), nodes, edges);
      expect(check).toMatchObject({ ok: false, code: 'loop_target_not_upstream' });
      expect(check.ok === false && check.reason).toContain('upstream');
    });

    it('refuses a source with no json output for the exit condition to read', () => {
      const textOnly = [node('a'), node('b'), node('c', false)];
      expect(canBeLoopEdge(candidate('c', 'a'), textOnly, edges)).toMatchObject({
        ok: false,
        code: 'loop_source_not_json',
      });
    });
  });

  describe('a diamond a → {b, c} → d', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [dataEdge('a', 'b'), dataEdge('a', 'c'), dataEdge('b', 'd'), dataEdge('c', 'd')];

    it('allows the join back to the split', () => {
      expect(canBeLoopEdge(candidate('d', 'a'), nodes, edges)).toEqual({ ok: true });
    });

    it('refuses a jump across the two branches — neither side is upstream of the other', () => {
      expect(canBeLoopEdge(candidate('b', 'c'), nodes, edges)).toMatchObject({
        ok: false,
        code: 'loop_target_not_upstream',
      });
    });

    it('refuses a second loop whose body overlaps the first (one loop per node)', () => {
      const withLoop: LoopGraph['edges'] = [
        ...edges,
        {
          id: 'loop-1',
          kind: 'loop',
          from: { nodeId: 'd', portId: portId('d', 'out', 'json') },
          to: { nodeId: 'a', portId: portId('a', 'in', 'json') },
        },
      ];
      expect(canBeLoopEdge(candidate('d', 'b'), nodes, withLoop)).toMatchObject({
        ok: false,
        code: 'loop_bodies_overlap',
      });
    });
  });

  describe('a self-loop', () => {
    const nodes = [node('a'), node('b')];
    const edges = [dataEdge('a', 'b')];

    it('refuses an edge from a node to itself — it is not upstream of itself', () => {
      expect(canBeLoopEdge(candidate('a', 'a'), nodes, edges)).toMatchObject({
        ok: false,
        code: 'loop_target_not_upstream',
      });
      expect(canBeLoopEdge(candidate('b', 'b'), nodes, edges)).toMatchObject({
        ok: false,
        code: 'loop_target_not_upstream',
      });
    });
  });

  it('refuses an edge whose source is not in the graph', () => {
    expect(canBeLoopEdge(candidate('ghost', 'a'), [node('a')], [])).toMatchObject({
      ok: false,
      code: 'loop_source_not_json',
    });
  });
});
