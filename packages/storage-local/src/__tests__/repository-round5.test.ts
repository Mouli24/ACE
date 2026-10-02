import type {
  KbChunk,
  KbDocument,
  KnowledgeBase,
  MemoryOp,
  NodeRun,
  NodeRunSource,
  Verdict,
} from '@ace/contracts';
import { newId, SecretWriteRejectedError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Fts5KeywordIndex, SqliteVectorIndex } from '../indexes.js';
import type { SqliteNodeRunPatch } from '../repository-runs.js';
import { scope } from './fixtures.js';
import { createTempDb, type TempDb } from './temp-db.js';

/**
 * The round 5 repositories (Arch §15.3, §21.3): knowledge bases, documents, chunks with their
 * vectors and FTS rows, agent memory and the summary cache. Each behaves as the engine's in-memory
 * `FakeRepository` does, so an engine test and the real store agree.
 */

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const OTHER = { workspaceId: 'other' };
const NOW = '2026-10-01T10:00:00.000Z';
const PROJECT_ID = newId();
const NODE_ID = newId();

const kb = (overrides: Partial<KnowledgeBase> = {}): KnowledgeBase => ({
  id: newId(),
  projectId: PROJECT_ID,
  name: 'Handbook',
  embeddingProviderId: newId(),
  embeddingModelId: 'mock-embed',
  chunkSize: 700,
  chunkOverlap: 90,
  documentCount: 0,
  chunkCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const doc = (knowledgeBaseId: string, overrides: Partial<KbDocument> = {}): KbDocument => ({
  id: newId(),
  knowledgeBaseId,
  artifactId: newId(),
  name: 'guide.md',
  mime: 'text/markdown',
  size: 120,
  status: 'pending',
  chunkCount: 0,
  createdAt: NOW,
  ...overrides,
});

const chunkOf = (document: KbDocument, ordinal: number, text: string): KbChunk => ({
  id: newId(),
  documentId: document.id,
  knowledgeBaseId: document.knowledgeBaseId,
  ordinal,
  text,
  tokens: Math.ceil(text.length / 4),
  source: `${document.name}#part-${ordinal}`,
  headings: ['Guide', `Part ${ordinal}`],
});

function count(sql: string, ...params: unknown[]): number {
  return (db.sqlite.prepare(sql).get(...params) as { n: number }).n;
}

/** How many FTS rows match a term — the index itself, not the chunk table. */
function ftsCount(term: string): number {
  return count(`SELECT count(*) AS n FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?`, `"${term}"`);
}

/* -------------------------------------------------------------------------- */
/* Knowledge bases                                                             */
/* -------------------------------------------------------------------------- */

describe('FR-RAG-001 knowledge bases repository', () => {
  it('round-trips a base, lists a project bases in id order, and patches the settings', async () => {
    const first = kb();
    const second = kb({ name: 'Second' });
    const elsewhere = kb({ projectId: newId() });
    await db.repository.knowledgeBases.insert(scope, first);
    await db.repository.knowledgeBases.insert(scope, second);
    await db.repository.knowledgeBases.insert(scope, elsewhere);

    expect(await db.repository.knowledgeBases.get(scope, first.id)).toEqual(first);
    expect(
      (await db.repository.knowledgeBases.listByProject(scope, PROJECT_ID)).map((b) => b.id),
    ).toEqual([first.id, second.id]);

    const patched = await db.repository.knowledgeBases.update(scope, first.id, {
      name: 'Renamed',
      chunkSize: 900,
      chunkOverlap: 100,
      updatedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(patched).toEqual({
      ...first,
      name: 'Renamed',
      chunkSize: 900,
      chunkOverlap: 100,
      updatedAt: '2026-10-02T10:00:00.000Z',
    });
    expect(await db.repository.knowledgeBases.update(scope, newId(), { name: 'x' })).toBeNull();
    expect(await db.repository.knowledgeBases.get(OTHER, first.id)).toBeNull();
  });

  it('derives documentCount and chunkCount from the rows, so they cannot drift', async () => {
    const base = kb();
    await db.repository.knowledgeBases.insert(scope, base);
    const document = doc(base.id);
    await db.repository.kbDocuments.insert(scope, document);
    await db.repository.kbChunks.replaceForDocument(
      scope,
      document.id,
      [chunkOf(document, 0, 'alpha'), chunkOf(document, 1, 'beta')],
      [
        [1, 0],
        [0, 1],
      ],
    );

    const read = await db.repository.knowledgeBases.get(scope, base.id);
    expect(read?.documentCount).toBe(1);
    expect(read?.chunkCount).toBe(2);
    // A patch of a derived count is ignored: the rows are the truth.
    const patched = await db.repository.knowledgeBases.update(scope, base.id, { chunkCount: 99 });
    expect(patched?.chunkCount).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

describe('FR-RAG-002 FR-RAG-003 documents repository', () => {
  it('round-trips a document with its verdicts and lists a base documents in id order', async () => {
    const base = kb();
    const verdicts = [
      {
        id: newId(),
        point: 'context',
        checkType: 'pii',
        action: 'redact',
        passed: true,
        reason: 'redacted an email',
        redactedTypes: ['email'],
        at: NOW,
      },
    ] satisfies KbDocument['verdicts'];
    const first = doc(base.id, { status: 'ready', chunkCount: 3, ingestedAt: NOW, verdicts });
    const second = doc(base.id);
    await db.repository.kbDocuments.insert(scope, first);
    await db.repository.kbDocuments.insert(scope, second);
    await db.repository.kbDocuments.insert(scope, doc(newId()));

    expect(await db.repository.kbDocuments.get(scope, first.id)).toEqual(first);
    expect(
      (await db.repository.kbDocuments.listByKnowledgeBase(scope, base.id)).map((d) => d.id),
    ).toEqual([first.id, second.id]);
    expect(await db.repository.kbDocuments.get(OTHER, first.id)).toBeNull();
  });

  it('lists the unsettled documents — every status but ready and failed (F7)', async () => {
    const base = kb();
    const statuses = ['pending', 'parsing', 'chunking', 'embedding', 'ready', 'failed'] as const;
    const docs = statuses.map((status) =>
      doc(base.id, status === 'failed' ? { status, error: 'bad' } : { status }),
    );
    for (const document of docs) await db.repository.kbDocuments.insert(scope, document);

    expect((await db.repository.kbDocuments.listUnsettled(scope)).map((d) => d.status)).toEqual([
      'pending',
      'parsing',
      'chunking',
      'embedding',
    ]);
  });

  it('patches the status, keeps an error until null clears it (D72)', async () => {
    const document = doc(newId(), { status: 'failed', error: 'could not parse' });
    await db.repository.kbDocuments.insert(scope, document);

    const kept = await db.repository.kbDocuments.update(scope, document.id, { status: 'pending' });
    expect(kept?.error).toBe('could not parse');
    expect(kept?.status).toBe('pending');

    const cleared = await db.repository.kbDocuments.update(scope, document.id, {
      status: 'ready',
      error: null,
      chunkCount: 4,
      ingestedAt: NOW,
      verdicts: [],
    });
    expect(cleared).toEqual({
      ...document,
      status: 'ready',
      chunkCount: 4,
      ingestedAt: NOW,
      verdicts: [],
      error: undefined,
    });
    expect(cleared && 'error' in cleared).toBe(false);

    const failed = await db.repository.kbDocuments.update(scope, document.id, {
      status: 'failed',
      error: 'Indexing failed: boom',
    });
    expect(failed?.error).toBe('Indexing failed: boom');
    expect(await db.repository.kbDocuments.update(scope, newId(), { status: 'ready' })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Chunks, vectors and the FTS index                                           */
/* -------------------------------------------------------------------------- */

describe('FR-RAG-002 replaceForDocument writes chunks, vectors and fts rows in one transaction; a throw leaves none', () => {
  it('writes all three, and a second call replaces rather than adds', async () => {
    const document = doc(newId());
    const first = [chunkOf(document, 0, 'orchid lattice'), chunkOf(document, 1, 'basalt ridge')];
    await db.repository.kbChunks.replaceForDocument(scope, document.id, first, [
      [1, 0],
      [0, 1],
    ]);
    expect(count('SELECT count(*) AS n FROM kb_chunks')).toBe(2);
    expect(count('SELECT count(*) AS n FROM kb_vectors')).toBe(2);
    expect(ftsCount('orchid')).toBe(1);

    const second = [chunkOf(document, 0, 'tundra signal')];
    await db.repository.kbChunks.replaceForDocument(scope, document.id, second, [[1, 1]]);
    expect(count('SELECT count(*) AS n FROM kb_chunks')).toBe(1);
    expect(count('SELECT count(*) AS n FROM kb_vectors')).toBe(1);
    expect(ftsCount('orchid')).toBe(0);
    expect(ftsCount('tundra')).toBe(1);

    expect(await db.repository.kbChunks.getMany(scope, [first[0]!.id, second[0]!.id])).toEqual(
      second,
    );
    const vectors = new SqliteVectorIndex(db.sqlite);
    expect(
      (await vectors.query(scope, document.knowledgeBaseId, [1, 1], 5)).map((m) => m.chunkId),
    ).toEqual([second[0]!.id]);
  });

  it('rolls everything back when a write fails part way, leaving the old chunks', async () => {
    const document = doc(newId());
    const old = [chunkOf(document, 0, 'orchid lattice')];
    await db.repository.kbChunks.replaceForDocument(scope, document.id, old, [[1, 0]]);

    const duplicate = chunkOf(document, 1, 'tundra signal');
    await expect(
      db.repository.kbChunks.replaceForDocument(
        scope,
        document.id,
        [chunkOf(document, 0, 'tundra first'), duplicate, { ...duplicate, ordinal: 2 }],
        [
          [1, 0],
          [0, 1],
          [1, 1],
        ],
      ),
    ).rejects.toThrow();

    expect(
      await db.repository.kbChunks.getMany(
        scope,
        old.map((c) => c.id),
      ),
    ).toEqual(old);
    expect(count('SELECT count(*) AS n FROM kb_chunks')).toBe(1);
    expect(count('SELECT count(*) AS n FROM kb_vectors')).toBe(1);
    expect(ftsCount('tundra')).toBe(0);
    expect(ftsCount('orchid')).toBe(1);
  });

  it('refuses a call whose embeddings do not pair with its chunks, before writing', async () => {
    const document = doc(newId());
    await expect(
      db.repository.kbChunks.replaceForDocument(
        scope,
        document.id,
        [chunkOf(document, 0, 'a')],
        [],
      ),
    ).rejects.toThrow('replaceForDocument needs one embedding per chunk');
    await expect(
      db.repository.kbChunks.replaceForDocument(
        scope,
        document.id,
        [chunkOf(document, 0, 'a')],
        [[Number.POSITIVE_INFINITY]],
      ),
    ).rejects.toThrow(/embedding/);
    expect(count('SELECT count(*) AS n FROM kb_chunks')).toBe(0);
  });

  it('reads chunks in the order asked, skips unknown ids, and counts by base', async () => {
    const document = doc(newId());
    const chunks = [chunkOf(document, 0, 'one'), chunkOf(document, 1, 'two')];
    await db.repository.kbChunks.replaceForDocument(scope, document.id, chunks, [
      [1, 0],
      [0, 1],
    ]);

    expect(
      (await db.repository.kbChunks.getMany(scope, [chunks[1]!.id, newId(), chunks[0]!.id])).map(
        (c) => c.text,
      ),
    ).toEqual(['two', 'one']);
    expect(await db.repository.kbChunks.getMany(scope, [])).toEqual([]);
    expect(await db.repository.kbChunks.getMany(OTHER, [chunks[0]!.id])).toEqual([]);
    expect(await db.repository.kbChunks.countByKnowledgeBase(scope, document.knowledgeBaseId)).toBe(
      2,
    );
    expect(await db.repository.kbChunks.countByKnowledgeBase(scope, newId())).toBe(0);
  });
});

describe('FR-RAG-008 deleting a document removes its chunks, vectors and fts rows', () => {
  it('takes the document and everything indexed from it, and nothing of its siblings', async () => {
    const base = kb();
    await db.repository.knowledgeBases.insert(scope, base);
    const gone = doc(base.id);
    const kept = doc(base.id);
    await db.repository.kbDocuments.insert(scope, gone);
    await db.repository.kbDocuments.insert(scope, kept);
    await db.repository.kbChunks.replaceForDocument(
      scope,
      gone.id,
      [chunkOf(gone, 0, 'orchid')],
      [[1, 0]],
    );
    await db.repository.kbChunks.replaceForDocument(
      scope,
      kept.id,
      [chunkOf(kept, 0, 'basalt')],
      [[0, 1]],
    );

    await db.repository.kbDocuments.delete(scope, gone.id);

    expect(await db.repository.kbDocuments.get(scope, gone.id)).toBeNull();
    expect(count('SELECT count(*) AS n FROM kb_chunks WHERE document_id = ?', gone.id)).toBe(0);
    expect(count('SELECT count(*) AS n FROM kb_vectors WHERE document_id = ?', gone.id)).toBe(0);
    expect(ftsCount('orchid')).toBe(0);
    expect(ftsCount('basalt')).toBe(1);
    const vectors = new SqliteVectorIndex(db.sqlite);
    expect((await vectors.query(scope, base.id, [1, 0], 5)).map((m) => m.chunkId)).toHaveLength(1);
    expect((await db.repository.knowledgeBases.get(scope, base.id))?.documentCount).toBe(1);
  });
});

describe('FR-RAG-001 deleting a KB cascades', () => {
  it('removes its documents, chunks, vectors and both indexes, and leaves other bases alone', async () => {
    const base = kb();
    const other = kb();
    await db.repository.knowledgeBases.insert(scope, base);
    await db.repository.knowledgeBases.insert(scope, other);
    const document = doc(base.id);
    const sibling = doc(other.id);
    await db.repository.kbDocuments.insert(scope, document);
    await db.repository.kbDocuments.insert(scope, sibling);
    await db.repository.kbChunks.replaceForDocument(
      scope,
      document.id,
      [chunkOf(document, 0, 'orchid'), chunkOf(document, 1, 'lattice')],
      [
        [1, 0],
        [0, 1],
      ],
    );
    await db.repository.kbChunks.replaceForDocument(
      scope,
      sibling.id,
      [chunkOf(sibling, 0, 'orchid')],
      [[1, 0]],
    );

    await db.repository.knowledgeBases.delete(scope, base.id);

    expect(await db.repository.knowledgeBases.get(scope, base.id)).toBeNull();
    expect(await db.repository.kbDocuments.get(scope, document.id)).toBeNull();
    expect(await db.repository.kbChunks.countByKnowledgeBase(scope, base.id)).toBe(0);
    expect(count('SELECT count(*) AS n FROM kb_vectors WHERE knowledge_base_id = ?', base.id)).toBe(
      0,
    );
    expect(ftsCount('lattice')).toBe(0);
    expect(ftsCount('orchid')).toBe(1);
    expect(await new SqliteVectorIndex(db.sqlite).query(scope, base.id, [1, 0], 5)).toEqual([]);
    expect(await new Fts5KeywordIndex(db.sqlite).search(scope, other.id, 'orchid', 5)).toHaveLength(
      1,
    );
    expect(await db.repository.kbDocuments.get(scope, sibling.id)).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Agent memory                                                                */
/* -------------------------------------------------------------------------- */

describe('FR-MEM-002 memory upsert replaces by key; clear returns what it removed; list is oldest first', () => {
  const ids = () => newId();

  it('keeps one value per key, oldest first, with the original id and createdAt', async () => {
    const first = await db.repository.memory.upsert(scope, NODE_ID, 'tone', 'formal', NOW, ids);
    const second = await db.repository.memory.upsert(
      scope,
      NODE_ID,
      'name',
      'Ada',
      '2026-10-01T10:00:01.000Z',
      ids,
    );
    const replaced = await db.repository.memory.upsert(
      scope,
      NODE_ID,
      'tone',
      'casual',
      '2026-10-01T10:00:02.000Z',
      ids,
    );

    expect(replaced).toEqual({ ...first, value: 'casual', updatedAt: '2026-10-01T10:00:02.000Z' });
    expect(await db.repository.memory.list(scope, NODE_ID)).toEqual([replaced, second]);
    expect(await db.repository.memory.list(scope, newId())).toEqual([]);
    expect(await db.repository.memory.list(OTHER, NODE_ID)).toEqual([]);
  });

  it('deletes by key and by entry, answering what it did', async () => {
    const entry = await db.repository.memory.upsert(scope, NODE_ID, 'tone', 'formal', NOW, ids);

    expect(await db.repository.memory.deleteKey(scope, NODE_ID, 'missing')).toBe(false);
    expect(await db.repository.memory.deleteEntry(scope, newId(), entry.id)).toBeNull();
    expect(await db.repository.memory.deleteEntry(scope, NODE_ID, entry.id)).toEqual(entry);
    expect(await db.repository.memory.deleteEntry(scope, NODE_ID, entry.id)).toBeNull();

    await db.repository.memory.upsert(scope, NODE_ID, 'tone', 'formal', NOW, ids);
    expect(await db.repository.memory.deleteKey(scope, NODE_ID, 'tone')).toBe(true);
    expect(await db.repository.memory.list(scope, NODE_ID)).toEqual([]);
  });

  it('clears one node and answers the removed entries, oldest first', async () => {
    const a = await db.repository.memory.upsert(scope, NODE_ID, 'a', '1', NOW, ids);
    const b = await db.repository.memory.upsert(
      scope,
      NODE_ID,
      'b',
      '2',
      '2026-10-01T10:00:01.000Z',
      ids,
    );
    const otherNode = newId();
    const kept = await db.repository.memory.upsert(scope, otherNode, 'a', '1', NOW, ids);

    expect(await db.repository.memory.clear(scope, NODE_ID)).toEqual([a, b]);
    expect(await db.repository.memory.list(scope, NODE_ID)).toEqual([]);
    expect(await db.repository.memory.list(scope, otherNode)).toEqual([kept]);
  });

  it('stamps lastUsedAt on the entries a run used', async () => {
    const a = await db.repository.memory.upsert(scope, NODE_ID, 'a', '1', NOW, ids);
    const b = await db.repository.memory.upsert(scope, NODE_ID, 'b', '2', NOW, ids);

    await db.repository.memory.markUsed(scope, [a.id, newId()], '2026-10-03T00:00:00.000Z');
    await db.repository.memory.markUsed(scope, [], '2026-10-04T00:00:00.000Z');

    const listed = await db.repository.memory.list(scope, NODE_ID);
    expect(listed.find((e) => e.id === a.id)?.lastUsedAt).toBe('2026-10-03T00:00:00.000Z');
    expect(listed.find((e) => e.id === b.id)).toEqual(b);
    // A later upsert keeps the last use, as the fake does.
    const updated = await db.repository.memory.upsert(
      scope,
      NODE_ID,
      'a',
      '9',
      '2026-10-05T00:00:00.000Z',
      ids,
    );
    expect(updated.lastUsedAt).toBe('2026-10-03T00:00:00.000Z');
  });

  it('refuses a key-shaped value, as every other write does (BR-07)', async () => {
    // Assembled at runtime, so no key-shaped literal is in the repository (CLAUDE.md §2).
    const key = ['ghp', '_', 'a1B2'.repeat(9)].join('');
    await expect(
      db.repository.memory.upsert(scope, NODE_ID, 'k', key, NOW, ids),
    ).rejects.toBeInstanceOf(SecretWriteRejectedError);
    await expect(db.repository.summaryCache.put(scope, 'k', key, NOW)).rejects.toBeInstanceOf(
      SecretWriteRejectedError,
    );
    expect(await db.repository.memory.list(scope, NODE_ID)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Summary cache                                                               */
/* -------------------------------------------------------------------------- */

describe('FR-RAG-010 summary cache: a hit refreshes last_used_at; >30 days is a miss; a 5,001st row evicts the least recently used', () => {
  const start = Date.parse('2026-10-01T00:00:00.000Z');
  const day = (n: number) => new Date(start + n * 86_400_000).toISOString();

  it('serves a hit and touches last_used_at', async () => {
    await db.repository.summaryCache.put(scope, 'k', 'summary', day(0));

    expect(await db.repository.summaryCache.get(scope, 'k', day(2))).toBe('summary');
    const row = db.sqlite
      .prepare('SELECT created_at, last_used_at FROM summary_cache WHERE key = ?')
      .get('k') as { created_at: string; last_used_at: string };
    expect(row).toEqual({ created_at: day(0), last_used_at: day(2) });
    expect(await db.repository.summaryCache.get(scope, 'missing', day(2))).toBeNull();
    expect(await db.repository.summaryCache.get(OTHER, 'k', day(2))).toBeNull();
  });

  it('expires 30 days after creation however often it is read', async () => {
    await db.repository.summaryCache.put(scope, 'k', 'summary', day(0));

    for (let n = 1; n <= 30; n += 1) {
      expect(await db.repository.summaryCache.get(scope, 'k', day(n))).toBe('summary');
    }
    expect(await db.repository.summaryCache.get(scope, 'k', day(31))).toBeNull();
    expect(count('SELECT count(*) AS n FROM summary_cache')).toBe(0);
    // A fresh put starts the 30 days again.
    await db.repository.summaryCache.put(scope, 'k', 'again', day(31));
    expect(await db.repository.summaryCache.get(scope, 'k', day(32))).toBe('again');
  });

  it('prunes to 5,000 rows, least recently used first', async () => {
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    const at = (n: number) => new Date(base + n * 1000).toISOString();
    await db.repository.transaction(async () => {
      for (let n = 0; n < 5000; n += 1) {
        await db.repository.summaryCache.put(scope, `k${n}`, 's', at(n));
      }
    });
    expect(count('SELECT count(*) AS n FROM summary_cache')).toBe(5000);
    // Reading k0 makes it recent, so k1 is now the least recently used.
    await db.repository.summaryCache.get(scope, 'k0', at(6000));
    await db.repository.summaryCache.put(scope, 'new', 's', at(6001));

    expect(count('SELECT count(*) AS n FROM summary_cache')).toBe(5000);
    expect(await db.repository.summaryCache.get(scope, 'k1', at(6002))).toBeNull();
    expect(await db.repository.summaryCache.get(scope, 'k0', at(6002))).toBe('s');
    expect(await db.repository.summaryCache.get(scope, 'new', at(6002))).toBe('s');
  });
});

/* -------------------------------------------------------------------------- */
/* Round 5 node-run and verdict fields                                         */
/* -------------------------------------------------------------------------- */

describe('FR-RAG-007 FR-MEM-002 a node run keeps its sources, dropped sources and memory ops', () => {
  it('round-trips the three round 5 fields, and leaves them absent when not given', async () => {
    const source: NodeRunSource = {
      chunkId: newId(),
      documentId: newId(),
      score: 0.5,
      source: 'guide.md#intro',
    };
    const memoryOps: MemoryOp[] = [
      { op: 'save', key: 'tone', value: 'formal' },
      { op: 'delete', key: 'old' },
    ];
    const nodeRun: NodeRun = {
      id: newId(),
      runId: newId(),
      nodeId: NODE_ID,
      iteration: 1,
      attempt: 1,
      status: 'COMPLETED',
      inputEnvelopes: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      verdicts: [],
      toolCalls: [],
      sources: [source],
      droppedSources: [{ ...source, chunkId: newId(), score: 0.1 }],
      memoryOps,
    };
    await db.repository.nodeRuns.create(scope, nodeRun);
    expect(await db.repository.nodeRuns.get(scope, nodeRun.id)).toEqual(nodeRun);

    const plain: NodeRun = { ...nodeRun, id: newId() };
    delete plain.sources;
    delete plain.droppedSources;
    delete plain.memoryOps;
    await db.repository.nodeRuns.create(scope, plain);
    expect(await db.repository.nodeRuns.get(scope, plain.id)).toEqual(plain);

    // The adapter already takes the three on update, ready for the port to name them.
    const patch: SqliteNodeRunPatch = { sources: [source], memoryOps };
    const updated = await db.repository.nodeRuns.update(scope, plain.id, patch);
    expect(updated).toEqual({ ...plain, sources: [source], memoryOps });
  });

  it('keeps a verdict strippedTypes in the table of record (TC-GRD-005)', async () => {
    const nodeRunId = newId();
    const verdict: Verdict = {
      id: newId(),
      nodeRunId,
      point: 'context',
      checkType: 'prompt_injection',
      action: 'warn',
      passed: false,
      reason: 'stripped hidden instructions',
      strippedTypes: ['html_comment', 'instruction_override'],
      at: NOW,
    };
    await db.repository.guardrailVerdicts.append(scope, verdict);

    expect(await db.repository.guardrailVerdicts.listByNodeRun(scope, nodeRunId)).toEqual([
      verdict,
    ]);
  });
});
