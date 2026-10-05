import { InstantiateTemplateRequestSchema, TemplateIdSchema } from '@ace/contracts';
import { Hono } from 'hono';

import { notFound, notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { TemplateService } from './service.js';

/**
 * The template routes (round 5 §2.7, §2.9, FR-ONB-002, TC-ONB-002):
 *
 * - `GET /templates` — a **bare** `Template[]`, in wizard order (D235).
 * - `POST /templates/:id/instantiate` — 201 `InstantiateTemplateResponse`: it creates the workflow,
 *   and the project unless `projectId` names one. An id that is no template is 404 (it names a
 *   resource that does not exist, before any body is read); naming both `projectId` and
 *   `projectName` is the contract's 400.
 *
 * `service` may be `undefined`: the routes then answer 501 `not_implemented` (D121).
 */

export type TemplateRouter = Hono<{ Variables: { requestId: string } }>;

export function createTemplateRoutes(service: TemplateService | undefined): TemplateRouter {
  const router: TemplateRouter = new Hono<{ Variables: { requestId: string } }>();

  const templates = (): TemplateService => {
    if (service === undefined) throw notImplemented('templates');
    return service;
  };

  router.get('/templates', (c) => c.json(templates().list()));

  router.post('/templates/:id/instantiate', async (c) => {
    const service = templates();
    const id = TemplateIdSchema.safeParse(c.req.param('id'));
    if (!id.success) throw notFound(`Template ${c.req.param('id')}`);
    const body = InstantiateTemplateRequestSchema.parse(await readJson(c));
    return c.json(await service.instantiate(id.data, body), 201);
  });

  return router;
}
