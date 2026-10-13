import {
  CreateEntryRequestSchema,
  FilePathQuerySchema,
  FileSearchRequestSchema,
  MoveEntryRequestSchema,
  RequiredFilePathQuerySchema,
  SaveFileRequestSchema,
} from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { WorkspaceService } from './service.js';

export type WorkspaceRouter = Hono<{ Variables: { requestId: string } }>;

/**
 * `/api/v1/projects/:id/files/*` (D299, design §6.1). Mounted inside the gateway's token, Origin
 * and request-id middleware; answers 501 when the engine was built without a workspace (D121).
 */
export function createWorkspaceRoutes(
  workspaceService: WorkspaceService | undefined,
): WorkspaceRouter {
  const router: WorkspaceRouter = new Hono<{ Variables: { requestId: string } }>();
  const workspace = (): WorkspaceService => {
    if (workspaceService === undefined) throw notImplemented('Project files');
    return workspaceService;
  };
  const base = '/projects/:id/files';

  router.get(`${base}/tree`, async (c) => {
    const { path } = FilePathQuerySchema.parse(c.req.query());
    return c.json(await workspace().listFolder(c.req.param('id'), path));
  });

  router.get(`${base}/content`, async (c) => {
    const { path } = RequiredFilePathQuerySchema.parse(c.req.query());
    return c.json(await workspace().read(c.req.param('id'), path));
  });

  router.get(`${base}/raw`, async (c) => {
    const { path } = RequiredFilePathQuerySchema.parse(c.req.query());
    const raw = await workspace().readRaw(c.req.param('id'), path);
    // An SVG opened on its own must not run script: the bytes are served as an inert document.
    return c.body(raw.bytes, 200, {
      'content-type': raw.contentType,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'no-store',
    });
  });

  router.put(`${base}/content`, async (c) => {
    const service = workspace();
    const body = SaveFileRequestSchema.parse(await readJson(c));
    return c.json(await service.save(c.req.param('id'), body));
  });

  router.post(`${base}/entries`, async (c) => {
    const service = workspace();
    const body = CreateEntryRequestSchema.parse(await readJson(c));
    return c.json(await service.create(c.req.param('id'), body), 201);
  });

  router.post(`${base}/move`, async (c) => {
    const service = workspace();
    const body = MoveEntryRequestSchema.parse(await readJson(c));
    return c.json(await service.move(c.req.param('id'), body.from, body.to));
  });

  router.delete(`${base}/entries`, async (c) => {
    const { path } = RequiredFilePathQuerySchema.parse(c.req.query());
    await workspace().remove(c.req.param('id'), path);
    return c.body(null, 204);
  });

  router.get(`${base}/list`, async (c) => c.json(await workspace().listAll(c.req.param('id'))));
  router.get(`${base}/status`, async (c) => c.json(await workspace().status(c.req.param('id'))));

  // A body, not query params: a regex is full of characters a query string mangles (D299 Phase 4).
  router.post(`${base}/search`, async (c) => {
    const service = workspace();
    const body = FileSearchRequestSchema.parse(await readJson(c));
    return c.json(await service.search(c.req.param('id'), body));
  });

  return router;
}
