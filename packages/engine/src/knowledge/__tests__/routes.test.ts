import {
  KbDocumentSchema,
  KnowledgeBaseSchema,
  SearchResponseSchema,
  type KnowledgeBase,
  type SearchRequest,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { newId } from '../../ids.js';
import { LOCAL_SCOPE, type ProviderAdapter } from '../../ports/index.js';
import { createKnowledgeRoutes } from '../routes.js';
import { KnowledgeBaseMissingError, type SearchService } from '../search.js';
import { createKnowledgeService } from '../service.js';
import { ListQueue, RecordingBus } from './harness.js';

/**
 * The knowledge-base routes of round 5 §2.9 (FR-RAG-001..004, FR-RAG-008, FR-RAG-009), over the real
 * knowledge service on the in-memory repository and a scripted search. What is under test is the
 * HTTP shape: the status of each answer, `{ items }` lists, bodies parsed by their contract schema
 * (400), unknown ids (404), and 501 when a service is absent (D121).
 */

const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const AT = '2026-10-05T09:00:00.000Z';

/** The real knowledge service on the in-memory repository, with ULIDs the contract accepts. */
async function knowledgeService() {
  const repo = new FakeRepository();
  await repo.projects.create(LOCAL_SCOPE, {
    id: PROJECT_ID,
    name: 'P',
    folderPath: '',
    createdAt: AT,
    updatedAt: AT,
  });
  const queue = new ListQueue();
  const artifacts = new Map<string, { name: string; mime: string; size: number }>();
  const adapter = { type: 'mock', embed: async (texts: string[]) => texts.map(() => [1, 0]) };
  const service = createKnowledgeService({
    repository: repo,
    scope: LOCAL_SCOPE,
    providers: {
      adapterFor: async (id) => {
        if (id !== PROVIDER_ID) throw new Error(`Provider ${id} was not found.`);
        return adapter as unknown as ProviderAdapter;
      },
    },
    artifacts: { get: async (id) => artifacts.get(id) ?? null },
    queue,
    bus: new RecordingBus(),
  });
  const addFile = (name: string): string => {
    const id = newId();
    artifacts.set(id, { name, mime: 'text/markdown', size: 10 });
    return id;
  };
  return { service, queue, addFile };
}

const createBody = {
  name: 'Handbook',
  embeddingProviderId: PROVIDER_ID,
  embeddingModelId: 'mock-embed',
};

/** A search that answers one fixed hit for any base it was told exists. */
function scriptedSearch(
  known: () => readonly string[],
): SearchService & { requests: SearchRequest[] } {
  const requests: SearchRequest[] = [];
  return {
    requests,
    async search(kbId, req) {
      requests.push(req);
      if (!known().includes(kbId)) throw new KnowledgeBaseMissingError(kbId);
      return {
        hits: [
          {
            chunkId: '01JBXQ8Z9KQ4R7N2VWXYZ0CHK1',
            documentId: '01JBXQ8Z9KQ4R7N2VWXYZ0DXC1',
            text: 'Suppliers send a bank letter.',
            score: 0.5,
            source: 'guide.md#intro',
            via: 'both',
          },
        ],
        tookMs: 3,
      };
    },
  };
}

async function harness() {
  const h = await knowledgeService();
  const bases: string[] = [];
  const search = scriptedSearch(() => bases);
  const app = routeApp(createKnowledgeRoutes(h.service, search));
  const create = async (body: unknown = createBody): Promise<KnowledgeBase> => {
    const response = await send(app, 'POST', `/projects/${PROJECT_ID}/knowledge-bases`, body);
    expect(response.status).toBe(201);
    const kb = KnowledgeBaseSchema.parse(await response.json());
    bases.push(kb.id);
    return kb;
  };
  return { h, app, search, create };
}

describe('FR-RAG-001 /projects/:id/knowledge-bases and /knowledge-bases/:id', () => {
  it('creates 201 with the contract defaults, reads it back and lists it in { items }', async () => {
    const { app, create } = await harness();

    const kb = await create();

    expect(kb).toMatchObject({ projectId: PROJECT_ID, chunkSize: 700, chunkOverlap: 90 });
    expect(await (await send(app, 'GET', `/knowledge-bases/${kb.id}`)).json()).toEqual(kb);
    const listed = await send(app, 'GET', `/projects/${PROJECT_ID}/knowledge-bases`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ items: [kb] });
  });

  it('refuses a body the contract refuses with 400, and an unknown project with 404', async () => {
    const { app } = await harness();
    const path = `/projects/${PROJECT_ID}/knowledge-bases`;

    for (const body of [
      {},
      { ...createBody, name: '' },
      { ...createBody, chunkSize: 300, chunkOverlap: 300 },
      { ...createBody, surprise: true },
      'not json',
    ]) {
      const response = await send(app, 'POST', path, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(response)).toBe('validation_failed');
    }

    const unknown = await send(
      app,
      'POST',
      '/projects/01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ/knowledge-bases',
      createBody,
    );
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe('not_found');

    // Listing under a project that does not exist is 404 too, as `/projects/:id/workflows` is.
    const listed = await send(app, 'GET', '/projects/01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ/knowledge-bases');
    expect(listed.status).toBe(404);
    expect(await errorCode(listed)).toBe('not_found');
  });

  it('PATCH renames and re-sizes; a bad patch is 400; DELETE is 204 and the base is then 404', async () => {
    const { app, create } = await harness();
    const kb = await create();

    const patched = await send(app, 'PATCH', `/knowledge-bases/${kb.id}`, {
      name: 'Renamed',
      chunkSize: 800,
    });
    expect(patched.status).toBe(200);
    expect(KnowledgeBaseSchema.parse(await patched.json())).toMatchObject({
      name: 'Renamed',
      chunkSize: 800,
    });

    // The embedder is fixed at creation (D235): the patch schema is strict and refuses it.
    const embedder = await send(app, 'PATCH', `/knowledge-bases/${kb.id}`, {
      embeddingModelId: 'other',
    });
    expect(embedder.status).toBe(400);
    // The overlap is checked against the stored size when the patch names only one (D235).
    const overlap = await send(app, 'PATCH', `/knowledge-bases/${kb.id}`, {
      chunkOverlap: 400,
      chunkSize: 300,
    });
    expect(overlap.status).toBe(400);

    const removed = await send(app, 'DELETE', `/knowledge-bases/${kb.id}`);
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    expect((await send(app, 'GET', `/knowledge-bases/${kb.id}`)).status).toBe(404);
    expect((await send(app, 'PATCH', `/knowledge-bases/${kb.id}`, { name: 'x' })).status).toBe(404);
    expect((await send(app, 'DELETE', `/knowledge-bases/${kb.id}`)).status).toBe(404);
  });
});

describe('FR-RAG-002 / FR-RAG-009 documents and reindex', () => {
  it('adding a document is 202 pending and queued; it lists in { items }; deleting it is 204', async () => {
    const { h, app, create } = await harness();
    const kb = await create();
    const artifactId = h.addFile('guide.md');

    const added = await send(app, 'POST', `/knowledge-bases/${kb.id}/documents`, { artifactId });

    expect(added.status).toBe(202);
    const doc = KbDocumentSchema.parse(await added.json());
    expect(doc).toMatchObject({
      knowledgeBaseId: kb.id,
      artifactId,
      status: 'pending',
      name: 'guide.md',
    });
    expect(h.queue.jobs).toEqual([{ knowledgeBaseId: kb.id, documentId: doc.id }]);
    expect(await (await send(app, 'GET', `/knowledge-bases/${kb.id}/documents`)).json()).toEqual({
      items: [doc],
    });

    const removed = await send(app, 'DELETE', `/kb-documents/${doc.id}`);
    expect(removed.status).toBe(204);
    expect((await send(app, 'DELETE', `/kb-documents/${doc.id}`)).status).toBe(404);
  });

  it('refuses a bad document body 400, an unknown artifact or base 404', async () => {
    const { h, app, create } = await harness();
    const kb = await create();

    expect((await send(app, 'POST', `/knowledge-bases/${kb.id}/documents`, {})).status).toBe(400);
    expect(
      (await send(app, 'POST', `/knowledge-bases/${kb.id}/documents`, { artifactId: 'not-an-id' }))
        .status,
    ).toBe(400);
    const noArtifact = await send(app, 'POST', `/knowledge-bases/${kb.id}/documents`, {
      artifactId: '01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ',
    });
    expect(noArtifact.status).toBe(404);
    const artifactId = h.addFile('guide.md');
    const noBase = await send(
      app,
      'POST',
      '/knowledge-bases/01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ/documents',
      {
        artifactId,
      },
    );
    expect(noBase.status).toBe(404);
    expect(
      (await send(app, 'GET', '/knowledge-bases/01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ/documents')).status,
    ).toBe(404);
  });

  it('reindex is 202 with no body and re-queues every document; an unknown base is 404', async () => {
    const { h, app, create } = await harness();
    const kb = await create();
    await send(app, 'POST', `/knowledge-bases/${kb.id}/documents`, {
      artifactId: h.addFile('a.md'),
    });
    await send(app, 'POST', `/knowledge-bases/${kb.id}/documents`, {
      artifactId: h.addFile('b.md'),
    });
    h.queue.jobs.length = 0;

    const reindexed = await send(app, 'POST', `/knowledge-bases/${kb.id}/reindex`);

    expect(reindexed.status).toBe(202);
    expect(await reindexed.text()).toBe('');
    expect(h.queue.jobs).toHaveLength(2);
    expect(
      (await send(app, 'POST', '/knowledge-bases/01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ/reindex')).status,
    ).toBe(404);
  });
});

describe('FR-RAG-004 / FR-RAG-008 POST /knowledge-bases/:id/query', () => {
  it('answers a SearchResponse, with k and mode defaulted by the contract', async () => {
    const { app, search, create } = await harness();
    const kb = await create();

    const response = await send(app, 'POST', `/knowledge-bases/${kb.id}/query`, {
      query: 'bank letter',
    });

    expect(response.status).toBe(200);
    expect(SearchResponseSchema.parse(await response.json()).hits).toHaveLength(1);
    expect(search.requests).toEqual([{ query: 'bank letter', k: 5, mode: 'hybrid' }]);
  });

  it('refuses an empty query, an out-of-range k and an unknown mode with 400; an unknown base is 404', async () => {
    const { app, create } = await harness();
    const kb = await create();
    const path = `/knowledge-bases/${kb.id}/query`;

    for (const body of [
      { query: '' },
      { query: 'x', k: 0 },
      { query: 'x', k: 21 },
      { query: 'x', mode: 'fuzzy' },
    ]) {
      expect((await send(app, 'POST', path, body)).status, JSON.stringify(body)).toBe(400);
    }
    const unknown = await send(app, 'POST', '/knowledge-bases/01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ/query', {
      query: 'x',
    });
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe('not_found');
  });

  it('any other search failure is the 500 envelope, never its message', async () => {
    const h = await knowledgeService();
    const failing: SearchService = {
      async search() {
        throw new Error('embedder at http://10.0.0.1 refused');
      },
    };
    const app = routeApp(createKnowledgeRoutes(h.service, failing));

    const response = await send(app, 'POST', '/knowledge-bases/01JBXQ8Z9KQ4R7N2VWXYZ0KBAS/query', {
      query: 'x',
    });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('10.0.0.1');
  });
});

describe('D121 a knowledge route whose service is absent answers 501', () => {
  it('answers 501 before reading a body: a malformed body without the service is still 501', async () => {
    const app = routeApp(createKnowledgeRoutes(undefined, undefined));
    const id = '01JBXQ8Z9KQ4R7N2VWXYZ0KBAS';
    for (const [method, path] of [
      ['POST', `/projects/${PROJECT_ID}/knowledge-bases`],
      ['PATCH', `/knowledge-bases/${id}`],
      ['POST', `/knowledge-bases/${id}/documents`],
      ['POST', `/knowledge-bases/${id}/query`],
    ] as const) {
      for (const body of ['{"broken":', { surprise: true }]) {
        const response = await send(app, method, path, body);
        expect(response.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(501);
        expect(await errorCode(response)).toBe('not_implemented');
      }
    }
  });

  it('every knowledge-base route without the knowledge service, and the query without search', async () => {
    const app = routeApp(createKnowledgeRoutes(undefined, undefined));
    const id = '01JBXQ8Z9KQ4R7N2VWXYZ0KBAS';
    const routes: [string, string, unknown?][] = [
      ['GET', `/projects/${PROJECT_ID}/knowledge-bases`],
      ['POST', `/projects/${PROJECT_ID}/knowledge-bases`, createBody],
      ['GET', `/knowledge-bases/${id}`],
      ['PATCH', `/knowledge-bases/${id}`, { name: 'x' }],
      ['DELETE', `/knowledge-bases/${id}`],
      ['POST', `/knowledge-bases/${id}/documents`, { artifactId: id }],
      ['GET', `/knowledge-bases/${id}/documents`],
      ['DELETE', `/kb-documents/${id}`],
      ['POST', `/knowledge-bases/${id}/reindex`],
      ['POST', `/knowledge-bases/${id}/query`, { query: 'x' }],
    ];
    for (const [method, path, body] of routes) {
      const response = await send(app, method, path, body);
      expect(response.status, `${method} ${path}`).toBe(501);
      expect(await errorCode(response)).toBe('not_implemented');
    }
  });
});
