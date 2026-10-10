import { Hono, type Env } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { DomainService } from './service.js';

/**
 * Domain's HTTP surface (D309, D314, D323), mounted by the gateway inside `/api/v1` and its auth.
 *
 *   POST /runs/:runId/messages  { text, deliveryMode?, exclude? }  → 201 { messageId, delivery[] }
 *                                400 a bad address (details.errors) · 409 the run has ended
 *   POST /runs/:runId/end                                          → Run
 *
 * `resolve` is a getter, as for the run controls: an app built without Domain answers 501.
 */
export function createDomainRoutes<E extends Env>(
  resolve: () => DomainService | undefined,
): Hono<E> {
  const routes = new Hono<E>();

  const domain = (): DomainService => {
    const service = resolve();
    if (service === undefined) throw notImplemented('Domain');
    return service;
  };

  routes.post('/runs/:runId/messages', async (c) => {
    const body = (await readJson(c)) as Parameters<DomainService['postMessage']>[1];
    return c.json(await domain().postMessage(c.req.param('runId'), body), 201);
  });

  routes.post('/runs/:runId/end', async (c) => c.json(await domain().end(c.req.param('runId'))));

  return routes;
}
