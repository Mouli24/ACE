import type { KbChunk, NodeRun, Run } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { LOCAL_WORKSPACE_ID } from '../ports/index.js';
import { FakeRepository } from './fake-repository.js';

const scope = { workspaceId: LOCAL_WORKSPACE_ID };
const NODE = '01JBXQ8Z9KQ4R7N2VWXYZ0NODE';

const chunk = (id: string, documentId: string): KbChunk => ({
  id,
  documentId,
  knowledgeBaseId: 'kb1',
  ordinal: 0,
  text: 'text',
  tokens: 1,
  source: 'a.md#top',
  headings: [],
});

const run = (id: string, workflowId: string, startedAt: string): Run =>
  ({ id, workflowId, status: 'COMPLETE', startedAt }) as unknown as Run;

const nodeRun = (
  id: string,
  runId: string,
  startedAt: string,
  providerId: string,
  costUsd: number,
): NodeRun =>
  ({
    id,
    runId,
    nodeId: NODE,
    status: 'COMPLETED',
    startedAt,
    durationMs: 100,
    modelUsed: { providerId, modelId: 'm', viaFallback: false },
    usage: { tokensIn: 10, tokensOut: 5, costUsd },
  }) as unknown as NodeRun;

describe('FR-RAG-010 the fake repository holds the round 5 ports', () => {
  it('replaces a document chunks in one go and cascades a delete', async () => {
    const repo = new FakeRepository();
    await repo.kbChunks.replaceForDocument(scope, 'd1', [chunk('c1', 'd1')], [[1]]);
    await repo.kbChunks.replaceForDocument(scope, 'd1', [chunk('c2', 'd1')], [[1]]);

    expect((await repo.kbChunks.getMany(scope, ['c1', 'c2'])).map((c) => c.id)).toEqual(['c2']);
    expect(await repo.kbChunks.countByKnowledgeBase(scope, 'kb1')).toBe(1);
    await repo.kbDocuments.delete(scope, 'd1');
    expect(await repo.kbChunks.countByKnowledgeBase(scope, 'kb1')).toBe(0);
  });
});

describe('FR-MEM-001 the fake memory keeps one value per key', () => {
  it('upserts, lists oldest first and clears', async () => {
    const repo = new FakeRepository();
    let n = 0;
    const newId = () => `id${(n += 1)}`;
    await repo.memory.upsert(scope, NODE, 'a', '1', '2026-10-01T00:00:00.000Z', newId);
    await repo.memory.upsert(scope, NODE, 'b', '2', '2026-10-01T00:00:01.000Z', newId);
    await repo.memory.upsert(scope, NODE, 'a', '3', '2026-10-01T00:00:02.000Z', newId);

    const entries = await repo.memory.list(scope, NODE);
    expect(entries.map((e) => [e.key, e.value])).toEqual([
      ['a', '3'],
      ['b', '2'],
    ]);
    expect(await repo.memory.deleteKey(scope, NODE, 'zzz')).toBe(false);
    expect(await repo.memory.clear(scope, NODE)).toHaveLength(2);
  });
});

describe('FR-OBS-002 the fake usage folds node runs with D234 semantics', () => {
  it('groups, bounds from inclusive and to exclusive, and orders buckets', async () => {
    const repo = new FakeRepository();
    await repo.runs.create(scope, run('r1', 'w1', '2026-10-01T10:00:00.000Z'));
    await repo.nodeRuns.create(scope, nodeRun('n1', 'r1', '2026-10-01T10:00:00.000Z', 'pb', 1));
    await repo.nodeRuns.create(scope, nodeRun('n2', 'r1', '2026-10-01T11:00:00.000Z', 'pa', 2));
    await repo.nodeRuns.create(scope, nodeRun('n3', 'r1', '2026-10-02T00:00:00.000Z', 'pa', 4));

    const all = await repo.usage.aggregate(scope, {
      from: '2026-10-01T10:00:00.000Z',
      to: '2026-10-02T00:00:00.000Z',
      groupBy: ['provider'],
    });
    expect(all.buckets.map((b) => b.key)).toEqual([{ provider: 'pa' }, { provider: 'pb' }]);
    expect(all.totals.costUsd).toBe(3);

    const byDay = await repo.usage.aggregate(scope, { groupBy: ['day', 'workflow'] });
    expect(byDay.buckets.map((b) => b.key.day)).toEqual(['2026-10-01', '2026-10-02']);
    expect(byDay.buckets[0]?.runs).toBe(1);
    expect((await repo.usage.dayTotals(scope, '2026-10-01')).costUsd).toBe(3);
  });

  it('fills every error kind and latency percentiles in the health counts', async () => {
    const repo = new FakeRepository();
    await repo.runs.create(scope, run('r1', 'w1', '2026-10-01T10:00:00.000Z'));
    await repo.nodeRuns.create(scope, nodeRun('n1', 'r1', '2026-10-01T10:00:00.000Z', 'pa', 1));

    const health = await repo.usage.healthCounts(scope);
    expect(Object.keys(health.nodeFailuresByKind)).toHaveLength(8);
    expect(health.providerLatencyMs).toEqual({ pa: { p50: 100, p95: 100 } });
    expect(health.runs).toEqual({ started: 1, completed: 1, halted: 0, blocked: 0 });
    expect(health.since).toBe('2026-10-01T10:00:00.000Z');
  });
});

describe('FR-RAG-010 the fake summary cache expires and prunes', () => {
  it('serves a hit and drops an entry unused for thirty days', async () => {
    const repo = new FakeRepository();
    await repo.summaryCache.put(scope, 'k', 's', '2026-10-01T00:00:00.000Z');

    expect(await repo.summaryCache.get(scope, 'k', '2026-10-02T00:00:00.000Z')).toBe('s');
    expect(await repo.summaryCache.get(scope, 'k', '2026-12-01T00:00:00.000Z')).toBeNull();
  });
});
