import { describe, expect, it } from 'vitest';

import { LOCAL_SCOPE } from '../../ports/index.js';
import { createKnowledgeService } from '../service.js';
import { PROJECT_ID, PROVIDER_ID, makeHarness } from './harness.js';

const body = {
  name: 'KB',
  embeddingProviderId: PROVIDER_ID,
  embeddingModelId: 'mock-embed',
  chunkSize: 700,
  chunkOverlap: 90,
};

describe('TC-RAG-001 creates a base with its settings', () => {
  it('stores the chunk settings and starts empty', async () => {
    const h = await makeHarness();
    const kb = await h.service.create(PROJECT_ID, { ...body, chunkSize: 500, chunkOverlap: 50 });
    expect(kb).toMatchObject({
      projectId: PROJECT_ID,
      name: 'KB',
      embeddingProviderId: PROVIDER_ID,
      embeddingModelId: 'mock-embed',
      chunkSize: 500,
      chunkOverlap: 50,
      documentCount: 0,
      chunkCount: 0,
    });
    expect(await h.service.get(kb.id)).toEqual(kb);
    expect(await h.service.list(PROJECT_ID)).toEqual([kb]);
  });

  it('404s an unknown project, and a missing base', async () => {
    const h = await makeHarness();
    await expect(h.service.create('nope', body)).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.service.list('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.service.get('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.service.remove('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.service.update('nope', { name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(h.service.reindex('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.service.listDocuments('nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(h.service.removeDocument('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('FR-RAG-001 an embedding provider without embed() is refused at create', () => {
  it('refuses an adapter with no embed()', async () => {
    const h = await makeHarness({ adapter: { type: 'mock' } });
    await expect(h.service.create(PROJECT_ID, body)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('refuses an unknown provider', async () => {
    const h = await makeHarness();
    await expect(
      h.service.create(PROJECT_ID, { ...body, embeddingProviderId: 'other' }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('FR-RAG-001 update checks the overlap against the stored size (D235)', () => {
  it('renames and applies new settings', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const next = await h.service.update(kb.id, { name: 'Renamed', chunkSize: 300 });
    expect(next).toMatchObject({ name: 'Renamed', chunkSize: 300, chunkOverlap: 90 });
  });

  it('refuses an overlap that does not fit the stored size, or a size the stored overlap does not fit', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    await expect(h.service.update(kb.id, { chunkOverlap: 700 })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(h.service.update(kb.id, { chunkSize: 90 })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      h.service.update(kb.id, { chunkSize: 400, chunkOverlap: 399 }),
    ).resolves.toMatchObject({
      chunkSize: 400,
      chunkOverlap: 399,
    });
  });
});

describe('FR-RAG-002 documents', () => {
  it('addDocument answers pending, counts it, queues it and announces it', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const artifactId = h.addFile('notes.txt', 'hello');
    const doc = await h.service.addDocument(kb.id, { artifactId });
    expect(doc).toMatchObject({
      knowledgeBaseId: kb.id,
      artifactId,
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      status: 'pending',
      chunkCount: 0,
    });
    expect(h.queue.jobs).toEqual([{ knowledgeBaseId: kb.id, documentId: doc.id }]);
    expect(await h.service.listDocuments(kb.id)).toEqual([doc]);
    expect(h.bus.ingest()).toEqual([
      { knowledgeBaseId: kb.id, documentId: doc.id, status: 'pending', progress: 0 },
    ]);
  });

  it('FR-RAG-002 adding an artifact the base already holds answers the existing document, once (final-review M7)', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const other = await h.createKb();
    const artifactId = h.addFile('notes.txt', 'hello');
    const first = await h.service.addDocument(kb.id, { artifactId });
    await h.worker.drain();
    const ready = await h.repo.kbDocuments.get(LOCAL_SCOPE, first.id);
    const events = h.bus.ingest().length;

    const again = await h.service.addDocument(kb.id, { artifactId });

    expect(again).toEqual(ready);
    expect(await h.service.listDocuments(kb.id)).toEqual([ready]);
    // Nothing queued or announced: the existing document is not re-ingested.
    expect(h.queue.jobs).toEqual([]);
    expect(h.bus.ingest()).toHaveLength(events);
    // Another base may still hold the same file.
    const elsewhere = await h.service.addDocument(other.id, { artifactId });
    expect(elsewhere.id).not.toBe(first.id);
  });

  it('404s a missing base or artifact', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    await expect(h.service.addDocument('nope', { artifactId: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(h.service.addDocument(kb.id, { artifactId: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('wakes the worker when a job is queued', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    let woken = 0;
    const service = createKnowledgeService({ ...h.serviceDeps, wake: () => void woken++ });
    await service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    expect(woken).toBe(1);
  });

  it('removing a base removes its documents and chunks', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    await h.worker.drain();
    await h.service.remove(kb.id);
    expect(await h.repo.knowledgeBases.get(LOCAL_SCOPE, kb.id)).toBeNull();
    expect(await h.repo.kbDocuments.listByKnowledgeBase(LOCAL_SCOPE, kb.id)).toEqual([]);
    expect(await h.repo.kbChunks.countByKnowledgeBase(LOCAL_SCOPE, kb.id)).toBe(0);
  });
});

describe('FR-RAG-009 recovery and reindex', () => {
  it('recovers an interrupted ingestion on start', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    const doc = await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    h.queue.jobs.length = 0;
    await h.repo.kbDocuments.update(LOCAL_SCOPE, doc.id, { status: 'parsing' });
    await expect(h.service.recover()).resolves.toBe(1);
    expect((await h.repo.kbDocuments.get(LOCAL_SCOPE, doc.id))?.status).toBe('pending');
    expect(h.queue.jobs).toEqual([{ knowledgeBaseId: kb.id, documentId: doc.id }]);
  });

  it('recover leaves settled documents alone', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    await h.worker.drain();
    await expect(h.service.recover()).resolves.toBe(0);
  });

  it('reindex re-queues every document as pending', async () => {
    const h = await makeHarness();
    const kb = await h.createKb();
    await h.service.addDocument(kb.id, { artifactId: h.addFile('a.txt', 'a') });
    await h.service.addDocument(kb.id, { artifactId: h.addFile('b.txt', 'b') });
    await h.worker.drain();
    await h.service.reindex(kb.id);
    expect(h.queue.jobs).toHaveLength(2);
    const docs = await h.service.listDocuments(kb.id);
    expect(docs.map((d) => d.status)).toEqual(['pending', 'pending']);
  });
});
