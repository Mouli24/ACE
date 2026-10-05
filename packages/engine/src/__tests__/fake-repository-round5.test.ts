import { ERROR_KINDS, type KbChunk, type KbDocument, type NodeRun, type Run } from '@ace/contracts';
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

describe('FR-RAG-001 the fake derives a base counts from its documents and chunks, as SQLite does', () => {
  const document = (id: string, status: KbDocument['status']): KbDocument => ({
    id,
    knowledgeBaseId: 'kb1',
    artifactId: '01JBXQ8Z9KQ4R7N2VWXYZ0ARTF',
    name: `${id}.md`,
    mime: 'text/markdown',
    size: 10,
    status,
    chunkCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
  });

  it('counts every document, pending and failed included, and every chunk; a patched count is ignored', async () => {
    const repo = new FakeRepository();
    await repo.knowledgeBases.insert(scope, {
      id: 'kb1',
      projectId: '01JBXQ8Z9KQ4R7N2VWXYZ0PROJ',
      name: 'Handbook',
      embeddingProviderId: '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD',
      embeddingModelId: 'mock-embed',
      chunkSize: 700,
      chunkOverlap: 90,
      documentCount: 7,
      chunkCount: 7,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    await repo.kbDocuments.insert(scope, document('d1', 'ready'));
    await repo.kbDocuments.insert(scope, document('d2', 'pending'));
    await repo.kbDocuments.insert(scope, document('d3', 'failed'));
    await repo.kbChunks.replaceForDocument(
      scope,
      'd1',
      [chunk('c1', 'd1'), chunk('c2', 'd1')],
      [[1], [1]],
    );
    await repo.knowledgeBases.update(scope, 'kb1', { documentCount: 99, chunkCount: 99 });

    expect(await repo.knowledgeBases.get(scope, 'kb1')).toMatchObject({
      documentCount: 3,
      chunkCount: 2,
    });
    const [listed] = await repo.knowledgeBases.listByProject(scope, '01JBXQ8Z9KQ4R7N2VWXYZ0PROJ');
    expect(listed).toMatchObject({ documentCount: 3, chunkCount: 2 });

    await repo.kbDocuments.delete(scope, 'd1');
    expect(await repo.knowledgeBases.get(scope, 'kb1')).toMatchObject({
      documentCount: 2,
      chunkCount: 0,
    });
  });

  it('FR-RAG-009 the retention sweep spares an artifact a knowledge-base document references', async () => {
    const repo = new FakeRepository();
    const old = '2026-09-01T00:00:00.000Z';
    for (const id of ['01JBXQ8Z9KQ4R7N2VWXYZ0ARTF', '01JBXQ8Z9KQ4R7N2VWXYZ0ARTG']) {
      await repo.artifacts.create(scope, {
        id,
        hash: id.slice(-1).repeat(64),
        mime: 'text/markdown',
        name: 'handbook.md',
        size: 10,
        createdAt: old,
      });
    }
    // `document()` points at ...ARTF; nothing points at ...ARTG.
    await repo.kbDocuments.insert(scope, document('d1', 'ready'));

    const swept = await repo.artifacts.unreferencedBefore(scope, '2026-09-20T00:00:00.000Z');
    expect(swept.map((artifact) => artifact.id)).toEqual(['01JBXQ8Z9KQ4R7N2VWXYZ0ARTG']);
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

  it('orders keys by binary comparison and ignores node runs that called no model', async () => {
    const repo = new FakeRepository();
    await repo.runs.create(scope, run('r1', 'w1', '2026-10-01T10:00:00.000Z'));
    await repo.nodeRuns.create(scope, nodeRun('n1', 'r1', '2026-10-01T10:00:00.000Z', 'a', 1));
    await repo.nodeRuns.create(scope, nodeRun('n2', 'r1', '2026-10-01T10:00:00.000Z', 'B', 1));
    const noModel = nodeRun('n3', 'r1', '2026-10-01T10:00:00.000Z', 'a', 100);
    delete (noModel as { modelUsed?: unknown }).modelUsed;
    await repo.nodeRuns.create(scope, noModel);

    const result = await repo.usage.aggregate(scope, { groupBy: ['provider'] });
    expect(result.buckets.map((b) => b.key.provider)).toEqual(['B', 'a']);
    expect(result.totals.costUsd).toBe(2);
    expect((await repo.usage.dayTotals(scope, '2026-10-01')).costUsd).toBe(2);
  });

  it('fills every error kind and latency percentiles in the health counts', async () => {
    const repo = new FakeRepository();
    await repo.runs.create(scope, run('r1', 'w1', '2026-10-01T10:00:00.000Z'));
    await repo.nodeRuns.create(scope, nodeRun('n1', 'r1', '2026-10-01T10:00:00.000Z', 'pa', 1));

    const health = await repo.usage.healthCounts(scope);
    expect(Object.keys(health.nodeFailuresByKind)).toHaveLength(ERROR_KINDS.length);
    expect(health.providerLatencyMs).toEqual({ pa: { p50: 100, p95: 100 } });
    expect(health.runs).toEqual({ started: 1, completed: 1, halted: 0, blocked: 0 });
    expect(health.since).toBe('2026-10-01T10:00:00.000Z');
  });

  it('TC-OBS-007 counts a FAILED node run, never a BLOCKED one that carries an error', async () => {
    const repo = new FakeRepository();
    await repo.runs.create(scope, run('r1', 'w1', '2026-10-01T10:00:00.000Z'));
    const error = { kind: 'workflow', code: 'x', message: 'upstream failed', retryable: false };
    for (const [id, status] of [
      ['n1', 'FAILED'],
      ['n2', 'BLOCKED'],
    ] as const) {
      const row = nodeRun(id, 'r1', '2026-10-01T10:00:00.000Z', 'pa', 0);
      await repo.nodeRuns.create(scope, { ...row, status, error } as NodeRun);
    }

    const health = await repo.usage.healthCounts(scope);
    expect(health.nodeFailuresByKind.workflow).toBe(1);
  });
});

describe('FR-RAG-010 the fake summary cache expires and prunes', () => {
  it('serves a hit', async () => {
    const repo = new FakeRepository();
    await repo.summaryCache.put(scope, 'k', 's', '2026-10-01T00:00:00.000Z');

    expect(await repo.summaryCache.get(scope, 'k', '2026-10-02T00:00:00.000Z')).toBe('s');
  });

  it('expires 30 days after creation however often it is read', async () => {
    const repo = new FakeRepository();
    const start = Date.parse('2026-10-01T00:00:00.000Z');
    const day = (n: number) => new Date(start + n * 86_400_000).toISOString();
    await repo.summaryCache.put(scope, 'k', 's', day(0));

    for (let n = 1; n <= 30; n += 1) {
      expect(await repo.summaryCache.get(scope, 'k', day(n))).toBe('s');
    }
    expect(await repo.summaryCache.get(scope, 'k', day(31))).toBeNull();
  });

  it('prunes to 5,000 rows, least recently used first', async () => {
    const repo = new FakeRepository();
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    const at = (n: number) => new Date(base + n * 1000).toISOString();
    for (let n = 0; n < 5000; n += 1) await repo.summaryCache.put(scope, `k${n}`, 's', at(n));
    // Reading k0 makes it recent, so k1 is now the least recently used.
    await repo.summaryCache.get(scope, 'k0', at(6000));
    await repo.summaryCache.put(scope, 'new', 's', at(6001));

    expect(await repo.summaryCache.get(scope, 'k1', at(6002))).toBeNull();
    expect(await repo.summaryCache.get(scope, 'k0', at(6002))).toBe('s');
    expect(await repo.summaryCache.get(scope, 'new', at(6002))).toBe('s');
  });
});

describe('FR-RAG-003 a re-ingested document loses its error', () => {
  it('clears the error when the patch says null', async () => {
    const repo = new FakeRepository();
    const doc = {
      id: 'd1',
      knowledgeBaseId: 'kb1',
      artifactId: 'a1',
      name: 'a.md',
      mime: 'text/markdown',
      size: 1,
      status: 'failed',
      chunkCount: 0,
      error: 'could not parse',
      createdAt: '2026-10-01T00:00:00.000Z',
    } satisfies KbDocument;
    await repo.kbDocuments.insert(scope, doc);

    const kept = await repo.kbDocuments.update(scope, 'd1', { status: 'pending' });
    expect(kept?.error).toBe('could not parse');
    const cleared = await repo.kbDocuments.update(scope, 'd1', { status: 'ready', error: null });
    expect(cleared?.error).toBeUndefined();
    expect(cleared?.status).toBe('ready');
  });
});
