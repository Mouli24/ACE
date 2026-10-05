import { describe, expect, it, vi } from 'vitest';

import { LOCAL_SCOPE } from '../../ports/index.js';
import type { ContextTextCheck } from '../../ports/knowledge.js';
import { fakeEmbedder, makeHarness } from './harness.js';

describe('TC-RAG-003 a corrupt file fails with its reason and its siblings reach ready', () => {
  it('fails only the corrupt document', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    for (let i = 0; i < 5; i++) {
      await h.service.addDocument(kb.id, { artifactId: h.addFile(`ok${i}.txt`, `text ${i}`) });
    }
    const bad = await h.service.addDocument(kb.id, {
      artifactId: h.addFile('bad.pdf', 'CORRUPT bytes'),
    });
    await h.worker.drain();

    const docs = await h.service.listDocuments(kb.id);
    expect(docs.filter((d) => d.status === 'ready')).toHaveLength(5);
    const failed = docs.find((d) => d.id === bad.id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'The file is corrupt and cannot be read.',
    });
  });

  it('prefixes a non-parse failure with "Indexing failed:"', async () => {
    const h = await makeHarness({
      embedder: async () => ({
        embed: async () => {
          throw new Error('model offline');
        },
      }),
    });
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    await h.worker.drain();
    expect((await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id))?.error).toBe(
      'Indexing failed: model offline',
    );
  });

  it('fails a document whose artifact is gone', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const artifactId = h.addFile('a.txt', 'a');
    const doc = await h.service.addDocument(kb.id, { artifactId });
    h.artifacts.delete(artifactId);
    await h.worker.drain();
    expect((await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id))?.status).toBe('failed');
  });
});

describe('FR-RAG-003 emits kb.ingest at every stage with rising progress', () => {
  it('walks pending, parsing, chunking, embedding, ready', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, {
      artifactId: h.addFile('a.txt', 'one\n\ntwo'),
    });
    await h.worker.drain();
    const events = h.bus.ingest().filter((e) => e.documentId === doc.id);
    expect(events.map((e) => [e.status, e.progress])).toEqual([
      ['pending', 0],
      ['parsing', 0.1],
      ['chunking', 0.3],
      ['embedding', 0.6],
      ['ready', 1],
    ]);
    expect(h.bus.events.every((e) => e.workflowId === undefined && e.runId === undefined)).toBe(
      true,
    );
    expect(await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id)).toMatchObject({
      status: 'ready',
      chunkCount: 2,
    });
  });

  it('emits failed with the error and no progress', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    await h.service.addDocument(kb.id, { artifactId: h.addFile('bad.txt', 'CORRUPT') });
    await h.worker.drain();
    const last = h.bus.ingest().at(-1);
    expect(last).toMatchObject({
      status: 'failed',
      error: 'The file is corrupt and cannot be read.',
    });
    expect(last?.progress).toBeUndefined();
  });

  it('clears an earlier error once the document re-ingests', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const artifactId = h.addFile('a.txt', 'CORRUPT');
    const doc = await h.service.addDocument(kb.id, { artifactId });
    await h.worker.drain();
    expect((await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id))?.error).toBeDefined();
    h.artifacts.set(artifactId, {
      ...h.artifacts.get(artifactId)!,
      bytes: new TextEncoder().encode('fine'),
    });
    await h.service.reindex(kb.id);
    await h.worker.drain();
    const after = await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id);
    expect(after?.status).toBe('ready');
    expect(after?.error).toBeUndefined();
  });
});

describe('FR-RAG-002 PII is redacted before chunking and recorded as a document verdict, types only', () => {
  it('chunks the redacted text and stores the verdicts', async () => {
    const check: ContextTextCheck = async ({ projectId, text }) => {
      expect(projectId).toBe('01PROJECT0000000000000000000');
      return {
        text: text.replace('jane@example.com', '[EMAIL]'),
        verdicts: [
          {
            id: 'v1',
            point: 'context',
            checkType: 'pii',
            action: 'redact',
            passed: false,
            reason: 'Redacted 1 value',
            redactedTypes: ['email'],
            at: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
    };
    const h = await makeHarness({ check });
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, {
      artifactId: h.addFile('a.txt', 'mail jane@example.com now'),
    });
    await h.worker.drain();
    const stored = await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id);
    expect(stored?.verdicts).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain('jane@example.com');
    expect(stored?.verdicts?.[0]).toMatchObject({ checkType: 'pii', redactedTypes: ['email'] });
    expect(h.written.map((c) => c.text)).toEqual(['mail [EMAIL] now']);
  });

  it('a blocked document fails with the reason and writes no chunks', async () => {
    const h = await makeHarness({
      check: async ({ text }) => ({ text, verdicts: [], blocked: 'Contains a national id.' }),
    });
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'x') });
    await h.worker.drain();
    expect(await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id)).toMatchObject({
      status: 'failed',
      error: 'Contains a national id.',
    });
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(0);
  });
});

describe('TC-RAG-008 deleting a document removes its chunks', () => {
  it('removes the row, the chunks and the count', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a\n\nb') });
    await h.worker.drain();
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(2);
    await h.service.removeDocument(doc.id);
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(0);
    expect(await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id)).toBeNull();
  });
});

describe('FR-RAG-009 reindex replaces, never duplicates', () => {
  it('keeps the chunk count and swaps every chunk id', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a\n\nb\n\nc') });
    await h.worker.drain();
    const before = h.written.map((c) => c.id);
    expect(before).toHaveLength(3);

    await h.service.reindex(kb.id);
    await h.worker.drain();
    const after = h.written.slice(3).map((c) => c.id);
    expect(after).toHaveLength(3);
    expect(await h.repo.kbChunks.getMany(LOCAL_SCOPE, before)).toEqual([]);
    expect(await h.repo.kbChunks.getMany(LOCAL_SCOPE, after)).toHaveLength(3);
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(3);
  });
});

describe('FR-RAG-003 drops the chunks of a document deleted mid-ingestion', () => {
  it('writes nothing when the document is deleted while embedding', async () => {
    const holder: { id?: string } = {};
    const h = await makeHarness({
      embedder: async () => ({
        embed: async (texts) => {
          await h.repo.kbDocuments.delete(LOCAL_SCOPE, holder.id!);
          return fakeEmbedder.embed(texts);
        },
      }),
    });
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a\n\nb') });
    holder.id = doc.id;
    await h.worker.drain();
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(0);
    expect(h.bus.ingest().some((e) => e.status === 'ready')).toBe(false);
    expect(h.bus.ingest().some((e) => e.status === 'failed')).toBe(false);
  });

  it('removes chunks that landed after the document was deleted', async () => {
    const holder: { id?: string } = {};
    const h = await makeHarness();
    const write = h.repo.kbChunks.replaceForDocument;
    h.repo.kbChunks.replaceForDocument = async (scope, documentId, chunks, embeddings) => {
      await h.repo.kbDocuments.delete(scope, holder.id!);
      await write(scope, documentId, chunks, embeddings);
    };
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    holder.id = doc.id;
    await h.worker.drain();
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(0);
  });
});

describe('FR-RAG-003 the worker', () => {
  it('start() drains what is queued and stop() waits for it', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    h.worker.start();
    h.worker.start();
    await h.worker.stop();
    const [doc] = await h.service.listDocuments(kb.id);
    expect(doc?.status).toBe('ready');
  });

  it('FR-SYS-008 stop() finishes the document in flight and leaves the rest queued for the next start (F7)', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await makeHarness({
      parser: {
        async parse({ bytes }) {
          await gate;
          return { text: new TextDecoder().decode(bytes), headings: [] };
        },
      },
    });
    const kb = await h.createKb();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await h.service.addDocument(kb.id, { artifactId: h.addFile(name, name) });
    }
    h.worker.start();
    // Until the first document is in flight, against a deadline that fails loudly, not a count.
    const deadline = Date.now() + 5000;
    while (!h.bus.ingest().some((e) => e.status === 'parsing')) {
      if (Date.now() > deadline) throw new Error('the first document never started parsing');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const stopped = h.worker.stop();
    release();
    await stopped;

    const statuses = (await h.service.listDocuments(kb.id)).map((doc) => [doc.name, doc.status]);
    expect(statuses).toEqual([
      ['a.txt', 'ready'],
      ['b.txt', 'pending'],
      ['c.txt', 'pending'],
    ]);
    // A drain after the stop still works through what was left.
    await h.worker.drain();
    expect((await h.service.listDocuments(kb.id)).every((doc) => doc.status === 'ready')).toBe(
      true,
    );
  });

  it('FR-SYS-008 its poll timer never keeps the process alive', async () => {
    const h = await makeHarness();
    const timers: ReturnType<typeof setInterval>[] = [];
    const real = globalThis.setInterval;
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      ...args: Parameters<typeof setInterval>
    ) => {
      const timer = real(...args);
      timers.push(timer);
      return timer;
    }) as typeof setInterval);
    try {
      h.worker.start();
    } finally {
      spy.mockRestore();
    }
    await h.worker.stop();

    expect(timers).toHaveLength(1);
    expect(timers[0]?.hasRef()).toBe(false);
  });

  it('skips a job whose document is already gone', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    await h.queue.enqueue(LOCAL_SCOPE, { knowledgeBaseId: kb.id, documentId: 'gone' });
    await h.worker.drain();
    expect(h.bus.ingest()).toEqual([]);
  });
});

describe('BR-07 ingested text is secret-masked before it is chunked or stored (D86, D115)', () => {
  // Assembled at runtime: a key-shaped literal in a repository file is what CLAUDE.md §2 forbids.
  const key = ['ghp', 'A1b2C3d4'.repeat(5)].join('_');

  it('chunks the masked text and records a data-point verdict, types only', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, {
      artifactId: h.addFile('a.md', `Deploy with ${key} today.\n\nSecond paragraph.`),
    });
    await h.worker.drain();

    const stored = await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id);
    expect(stored?.status).toBe('ready');
    expect(h.written.map((chunk) => chunk.text)).toEqual([
      'Deploy with [REDACTED] today.',
      'Second paragraph.',
    ]);
    expect(stored?.verdicts).toEqual([
      {
        id: expect.any(String),
        point: 'data',
        checkType: 'secret_leak',
        action: 'redact',
        passed: false,
        reason: expect.any(String),
        redactedTypes: ['api_key'],
        at: expect.any(String),
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain(key);
  });

  it('lists the PII verdicts first, then the data verdict, and rebuilds heading offsets', async () => {
    const text = `# Setup\ntoken ${key} here\n# Usage\nbody`;
    const headings = [
      { level: 1, title: 'Setup', offset: 2 },
      { level: 1, title: 'Usage', offset: text.indexOf('Usage') },
    ];
    const pii = {
      id: 'v1',
      point: 'context' as const,
      checkType: 'pii' as const,
      action: 'warn' as const,
      passed: false,
      reason: 'Found 1 value',
      at: '2026-01-01T00:00:00.000Z',
    };
    const h = await makeHarness({
      parser: { parse: async () => ({ text, headings }) },
      check: async ({ text: t }) => {
        // The PII step reads the masked text: the key never reaches it.
        expect(t).not.toContain(key);
        return { text: t, verdicts: [pii] };
      },
    });
    const seen: { text: string; headings: { title: string; offset: number }[] }[] = [];
    h.workerDeps.chunker = {
      chunk: ({ document }) => {
        seen.push(document);
        return [];
      },
    };
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.md', 'x') });
    await h.worker.drain();

    const document = seen[0]!;
    expect(document.text).toBe('# Setup\ntoken [REDACTED] here\n# Usage\nbody');
    expect(document.headings.map((x) => x.title)).toEqual(['Setup', 'Usage']);
    for (const heading of document.headings) {
      expect(document.text.slice(heading.offset).startsWith(heading.title)).toBe(true);
    }
    const stored = await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id);
    expect(stored?.verdicts?.map((v) => [v.point, v.checkType])).toEqual([
      ['context', 'pii'],
      ['data', 'secret_leak'],
    ]);
  });

  it('records no data verdict when nothing was masked', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.md', 'clean') });
    await h.worker.drain();

    expect((await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id))?.verdicts).toEqual([]);
  });

  it('masks a failure reason before it is stored or announced', async () => {
    const h = await makeHarness({
      embedder: async () => ({
        embed: async () => {
          throw new Error(`the provider rejected ${key}`);
        },
      }),
    });
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    await h.worker.drain();

    const stored = await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id);
    expect(stored?.error).toBe('Indexing failed: the provider rejected [REDACTED]');
    expect(JSON.stringify(h.bus.ingest())).not.toContain(key);
  });
});
