import {
  AcceptSuggestionRequestSchema,
  CreateProjectNoteRequestSchema,
  CreateResponsibilityRequestSchema,
  ImportEmailRequestSchema,
  SuggestionListQuerySchema,
  UpdateProjectNoteRequestSchema,
  UpdateResponsibilityRequestSchema,
} from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { SuggestionService } from './service.js';

/**
 * Suggestions, responsibilities, team notes and email import (ACE parity P2, D280–D282). Lists are
 * `{ items }`, creates 201, deletes 204; a scan answers at once with the responsibility `running`
 * and `project.changed` reports the rest. Built without the service, every route answers 501.
 */
export type SuggestionRouter = Hono<{ Variables: { requestId: string } }>;

export function createSuggestionRoutes(
  suggestionService: SuggestionService | undefined,
): SuggestionRouter {
  const router: SuggestionRouter = new Hono<{ Variables: { requestId: string } }>();
  const service = (): SuggestionService => {
    if (suggestionService === undefined) throw notImplemented('suggestions');
    return suggestionService;
  };

  router.get('/projects/:id/responsibilities', async (c) =>
    c.json({ items: await service().listResponsibilities(c.req.param('id')) }),
  );
  router.post('/projects/:id/responsibilities', async (c) => {
    const s = service();
    const body = CreateResponsibilityRequestSchema.parse(await readJson(c));
    return c.json(await s.createResponsibility(c.req.param('id'), body), 201);
  });
  router.patch('/responsibilities/:id', async (c) => {
    const s = service();
    const body = UpdateResponsibilityRequestSchema.parse(await readJson(c));
    return c.json(await s.updateResponsibility(c.req.param('id'), body));
  });
  router.delete('/responsibilities/:id', async (c) => {
    await service().deleteResponsibility(c.req.param('id'));
    return c.body(null, 204);
  });
  router.post('/responsibilities/:id/scan', async (c) =>
    c.json(await service().scan(c.req.param('id'))),
  );
  router.post('/responsibilities/:id/cancel-scan', async (c) =>
    c.json(await service().cancelScan(c.req.param('id'))),
  );

  router.get('/projects/:id/suggestions', async (c) => {
    const s = service();
    const query = SuggestionListQuerySchema.parse(c.req.query());
    return c.json({ items: await s.listSuggestions(c.req.param('id'), query) });
  });
  router.post('/suggestions/:id/accept', async (c) => {
    const s = service();
    const text = await c.req.raw.clone().text();
    const body = AcceptSuggestionRequestSchema.parse(text.trim() === '' ? {} : await readJson(c));
    return c.json(await s.accept(c.req.param('id'), body));
  });
  router.post('/suggestions/:id/later', async (c) =>
    c.json(await service().later(c.req.param('id'))),
  );
  router.post('/suggestions/:id/dismiss', async (c) =>
    c.json(await service().dismiss(c.req.param('id'))),
  );

  router.get('/projects/:id/notes', async (c) =>
    c.json({ items: await service().listNotes(c.req.param('id')) }),
  );
  router.post('/projects/:id/notes', async (c) => {
    const s = service();
    const body = CreateProjectNoteRequestSchema.parse(await readJson(c));
    return c.json(await s.createNote(c.req.param('id'), body), 201);
  });
  router.patch('/notes/:id', async (c) => {
    const s = service();
    const body = UpdateProjectNoteRequestSchema.parse(await readJson(c));
    return c.json(await s.updateNote(c.req.param('id'), body));
  });
  router.delete('/notes/:id', async (c) => {
    await service().deleteNote(c.req.param('id'));
    return c.body(null, 204);
  });

  router.post('/projects/:id/tasks/import-email', async (c) => {
    const s = service();
    const body = ImportEmailRequestSchema.parse(await readJson(c));
    return c.json(await s.importEmail(c.req.param('id'), body), 201);
  });

  return router;
}
