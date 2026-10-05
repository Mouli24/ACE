import {
  AddKbDocumentRequestSchema,
  CreateKnowledgeBaseRequestSchema,
  SearchRequestSchema,
  UpdateKnowledgeBaseRequestSchema,
} from '@ace/contracts';
import { Hono } from 'hono';

import { notFound, notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import { KnowledgeBaseMissingError, type SearchService } from './search.js';
import type { KnowledgeService } from './service.js';

/**
 * The knowledge-base routes (round 5 §2.9, D235, FR-RAG-001..004, FR-RAG-008, FR-RAG-009).
 *
 * Every body is parsed with its contract schema, and the service answers in the §2.3 envelope
 * (`notFound` / `validationFailed`), so these handlers only shape the HTTP answer: lists are
 * `{ items }` (D64, D235), a create is 201, a delete is 204, and the two calls that only queue work
 * — adding a document and a reindex — are 202, with `kb.ingest` reporting the rest.
 *
 * Either service may be `undefined`: an app built without it answers its routes 501
 * `not_implemented`, the gateway's convention for a service it was built without (D121).
 */

export type KnowledgeRouter = Hono<{ Variables: { requestId: string } }>;

export function createKnowledgeRoutes(
  knowledgeService: KnowledgeService | undefined,
  searchService: SearchService | undefined,
): KnowledgeRouter {
  const router: KnowledgeRouter = new Hono<{ Variables: { requestId: string } }>();

  const knowledge = (): KnowledgeService => {
    if (knowledgeService === undefined) throw notImplemented('knowledge bases');
    return knowledgeService;
  };

  const search = (): SearchService => {
    if (searchService === undefined) throw notImplemented('knowledge-base search');
    return searchService;
  };

  router.get('/projects/:id/knowledge-bases', async (c) =>
    c.json({ items: await knowledge().list(c.req.param('id')) }),
  );

  router.post('/projects/:id/knowledge-bases', async (c) => {
    const body = CreateKnowledgeBaseRequestSchema.parse(await readJson(c));
    return c.json(await knowledge().create(c.req.param('id'), body), 201);
  });

  router.get('/knowledge-bases/:id', async (c) => c.json(await knowledge().get(c.req.param('id'))));

  router.patch('/knowledge-bases/:id', async (c) => {
    const patch = UpdateKnowledgeBaseRequestSchema.parse(await readJson(c));
    return c.json(await knowledge().update(c.req.param('id'), patch));
  });

  // Removes its documents, chunks, vectors and FTS rows with it (§2.9).
  router.delete('/knowledge-bases/:id', async (c) => {
    await knowledge().remove(c.req.param('id'));
    return c.body(null, 204);
  });

  // 202: the document is recorded `pending` and queued; ingestion reports through `kb.ingest`.
  router.post('/knowledge-bases/:id/documents', async (c) => {
    const body = AddKbDocumentRequestSchema.parse(await readJson(c));
    return c.json(await knowledge().addDocument(c.req.param('id'), body), 202);
  });

  router.get('/knowledge-bases/:id/documents', async (c) =>
    c.json({ items: await knowledge().listDocuments(c.req.param('id')) }),
  );

  // FR-RAG-009: its chunks and vectors go with it.
  router.delete('/kb-documents/:id', async (c) => {
    await knowledge().removeDocument(c.req.param('id'));
    return c.body(null, 204);
  });

  router.post('/knowledge-bases/:id/reindex', async (c) => {
    await knowledge().reindex(c.req.param('id'));
    return c.body(null, 202);
  });

  router.post('/knowledge-bases/:id/query', async (c) => {
    const request = SearchRequestSchema.parse(await readJson(c));
    const id = c.req.param('id');
    try {
      return c.json(await search().search(id, request));
    } catch (error) {
      // The search port names a missing base by type; over HTTP that is the base not found.
      if (error instanceof KnowledgeBaseMissingError) throw notFound(`Knowledge base ${id}`);
      throw error;
    }
  });

  return router;
}
