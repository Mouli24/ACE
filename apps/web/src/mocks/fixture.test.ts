import { MockDb } from './db';
import { PERF_FIXTURE, seedPerfFixture } from './fixture';
import { applyOpsWithRules } from './graph-rules';

describe('?fixture=200 perf graph (NFR-PERF-01, TC-NFR-001)', () => {
  it('seeds exactly 200 nodes and 400 edges that the graph rules accept', () => {
    const db = new MockDb({ persist: false });
    const { workflowId } = seedPerfFixture(db);
    const nodes = db.nodesOf(workflowId);
    const edges = db.edgesOf(workflowId);
    expect(nodes).toHaveLength(PERF_FIXTURE.nodes);
    expect(edges).toHaveLength(PERF_FIXTURE.edges);
    const replay = applyOpsWithRules(
      workflowId,
      [],
      [],
      [
        ...nodes.map((node) => ({ op: 'add_node' as const, node })),
        ...edges.map((edge) => ({ op: 'add_edge' as const, edge })),
      ],
    );
    expect(replay.ok).toBe(true);
  });

  it('is idempotent: seeding twice reuses the same workflow', () => {
    const db = new MockDb({ persist: false });
    const first = seedPerfFixture(db);
    const second = seedPerfFixture(db);
    expect(second.workflowId).toBe(first.workflowId);
  });
});
