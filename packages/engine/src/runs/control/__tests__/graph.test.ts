import { describe, expect, it } from 'vitest';

import { agentNode, edge, inputNode, outputNode } from './harness.js';
import { dataEdges, downstreamOf, upstreamOf } from '../graph.js';

describe('FR-ERR-004 / FR-EXE-013 Reachability over a snapshot', () => {
  const brief = inputNode('Brief');
  const writer = agentNode('Writer');
  const reviewer = agentNode('Reviewer');
  const result = outputNode('Result');
  const chain = [edge(brief, writer), edge(writer, reviewer), edge(reviewer, result)];

  it('downstream is everything after a node, transitively', () => {
    expect([...downstreamOf(writer.id, chain)].sort()).toEqual([reviewer.id, result.id].sort());
  });

  it('upstream is everything that feeds a node, transitively', () => {
    expect([...upstreamOf(reviewer.id, chain)].sort()).toEqual([brief.id, writer.id].sort());
  });

  it('never includes the node itself', () => {
    expect(downstreamOf(writer.id, chain).has(writer.id)).toBe(false);
    expect(upstreamOf(writer.id, chain).has(writer.id)).toBe(false);
  });

  it('a terminal node has nothing after it, a source nothing before it', () => {
    expect(downstreamOf(result.id, chain).size).toBe(0);
    expect(upstreamOf(brief.id, chain).size).toBe(0);
  });

  it('follows both arms of a parallel branch into a merge', () => {
    const left = agentNode('Left');
    const right = agentNode('Right');
    const merge = agentNode('Merge');
    const edges = [
      edge(brief, left),
      edge(brief, right),
      edge(left, merge),
      edge(right, merge),
      edge(merge, result),
    ];

    expect([...downstreamOf(brief.id, edges)].sort()).toEqual(
      [left.id, right.id, merge.id, result.id].sort(),
    );
    expect([...upstreamOf(merge.id, edges)].sort()).toEqual([brief.id, left.id, right.id].sort());
  });

  it('ignores loop edges, so a loop body is not upstream and downstream of itself (D73)', () => {
    // Reviewer loops back into Writer: as data that would make each the other's downstream.
    const edges = [...chain, edge(reviewer, writer, 'loop')];

    expect(downstreamOf(reviewer.id, edges).has(writer.id)).toBe(false);
    expect(upstreamOf(writer.id, edges).has(reviewer.id)).toBe(false);
    expect(dataEdges(edges)).toHaveLength(3);
  });

  it('terminates on a data cycle rather than looping for ever', () => {
    const edges = [edge(writer, reviewer), edge(reviewer, writer)];
    expect([...downstreamOf(writer.id, edges)]).toEqual([reviewer.id]);
  });

  it('answers empty for a node id that is not in the edge list at all', () => {
    expect(downstreamOf('01JBXQ8Z9KQ4R7N2VWXYZ0NONE', chain).size).toBe(0);
  });
});
