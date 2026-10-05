import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import type { MemoryService } from './service.js';

/**
 * The memory routes (round 5 §2.9, FR-MEM-004, TC-MEM-002): an agent's remembered facts, oldest
 * first, as a **bare** `MemoryEntry[]` (§2.9 writes it that way, D235); delete one, or clear all —
 * both 204, each change announced by the service with `memory.updated`. An unknown entry is the
 * service's 404; a node with no memory simply has none.
 *
 * `service` may be `undefined`: the routes then answer 501 `not_implemented` (D121).
 */

export type MemoryRouter = Hono<{ Variables: { requestId: string } }>;

export function createMemoryRoutes(service: MemoryService | undefined): MemoryRouter {
  const router: MemoryRouter = new Hono<{ Variables: { requestId: string } }>();

  const memory = (): MemoryService => {
    if (service === undefined) throw notImplemented('agent memory');
    return service;
  };

  router.get('/nodes/:id/memory', async (c) => c.json(await memory().list(c.req.param('id'))));

  router.delete('/nodes/:id/memory/:entryId', async (c) => {
    await memory().deleteEntry(c.req.param('id'), c.req.param('entryId'));
    return c.body(null, 204);
  });

  router.delete('/nodes/:id/memory', async (c) => {
    await memory().clear(c.req.param('id'));
    return c.body(null, 204);
  });

  return router;
}
