import { describe, expect, it } from 'vitest';

import { LOCAL_SCOPE } from '../../ports/index.js';
import { makeHarness } from './harness.js';

describe('FR-RAG-002 heading offsets follow the sanitised text', () => {
  it('rebuilds offsets after a redaction that changes the length, dropping a redacted heading', async () => {
    const text = '# One\nmail jane@example.com now\n# Two\nbody\n# jane@example.com\ntail';
    const headings = [
      { level: 1, title: 'One', offset: text.indexOf('One') - 2 },
      { level: 1, title: 'Two', offset: text.indexOf('Two') - 2 },
      { level: 1, title: 'jane@example.com', offset: text.lastIndexOf('jane@example.com') - 2 },
    ];
    const h = await makeHarness({
      parser: { parse: async () => ({ text, headings }) },
      check: async ({ text: t }) => ({
        text: t.replaceAll('jane@example.com', '[E]'),
        verdicts: [],
      }),
    });
    const seen: { text: string; headings: { title: string; offset: number }[] }[] = [];
    h.workerDeps.chunker = {
      chunk: ({ document }) => {
        seen.push(document);
        return [];
      },
    };
    const kb = await h.createKb();
    await h.service.addDocument(kb.id, { artifactId: h.addFile('a.md', 'x') });
    await h.worker.drain();

    expect(seen).toHaveLength(1);
    const doc = seen[0]!;
    expect(doc.headings.map((x) => x.title)).toEqual(['One', 'Two']);
    for (const heading of doc.headings) {
      expect(doc.text.slice(heading.offset).startsWith(heading.title)).toBe(true);
    }
  });

  it('passes headings through when nothing changed', async () => {
    const headings = [{ level: 1, title: 'One', offset: 2 }];
    const h = await makeHarness({
      parser: { parse: async () => ({ text: '# One\nbody', headings }) },
    });
    const seen: unknown[] = [];
    h.workerDeps.chunker = {
      chunk: ({ document }) => {
        seen.push(document.headings);
        return [];
      },
    };
    const kb = await h.createKb();
    await h.service.addDocument(kb.id, { artifactId: h.addFile('a.md', 'x') });
    await h.worker.drain();
    expect(seen).toEqual([headings]);
  });
});

describe('FR-RAG-003 one document cannot stop its siblings', () => {
  it('a repository throw for document A leaves document B ready and the drain resolved', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const a = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    const b = await h.service.addDocument(kb.id, { artifactId: h.addFile('b.txt', 'b') });
    const update = h.repo.kbDocuments.update;
    h.repo.kbDocuments.update = async (scope, id, patch) => {
      if (id === a.id) throw new Error('disk full');
      return update(scope, id, patch);
    };
    await expect(h.worker.drain()).resolves.toBeUndefined();
    expect((await h.repo.kbDocuments.get(LOCAL_SCOPE, b.id))?.status).toBe('ready');
    expect(h.logLines.join('')).toContain('disk full');
  });

  it('a failing ready announcement does not turn a ready document failed', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    const emit = h.bus.emit.bind(h.bus);
    h.bus.emit = async (event) => {
      if ((event.payload as { status?: string }).status === 'ready') throw new Error('hub down');
      return emit(event);
    };
    await h.worker.drain();
    expect((await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id))?.status).toBe('ready');
    expect(h.bus.ingest().some((e) => e.status === 'failed')).toBe(false);
    expect(h.logLines.join('')).toContain('hub down');
  });
});

describe('FR-RAG-003 a failed document keeps no chunks', () => {
  it('a reindex that fails clears the document chunks', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const artifactId = h.addFile('a.txt', 'a\n\nb');
    const doc = await h.service.addDocument(kb.id, { artifactId });
    await h.worker.drain();
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(2);

    h.artifacts.set(artifactId, {
      ...h.artifacts.get(artifactId)!,
      bytes: new TextEncoder().encode('CORRUPT'),
    });
    await h.service.reindex(kb.id);
    await h.worker.drain();
    expect((await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id))?.status).toBe('failed');
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(0);
  });

  it('FR-RAG-009 a reindex whose source file is missing keeps the chunks of the last good ingest', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const artifactId = h.addFile('a.txt', 'a\n\nb');
    const doc = await h.service.addDocument(kb.id, { artifactId });
    await h.worker.drain();
    const before = await h.repo.kbChunks.getMany(
      LOCAL_SCOPE,
      h.written.map((chunk) => chunk.id),
    );
    expect(before).toHaveLength(2);

    // The source was never read, so nothing about the content is known to be wrong: losing the
    // base's only copy of it would be worse than serving it (final-review C1 ruling).
    h.artifacts.delete(artifactId);
    await h.service.reindex(kb.id);
    await h.worker.drain();

    const failed = await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/source file missing/i);
    expect(
      await h.repo.kbChunks.getMany(
        LOCAL_SCOPE,
        before.map((chunk) => chunk.id),
      ),
    ).toEqual(before);
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(2);
    expect(h.bus.ingest().at(-1)).toMatchObject({ status: 'failed', error: failed?.error });
  });
});
