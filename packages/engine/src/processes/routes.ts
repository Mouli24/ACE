import { ProcessInputRequestSchema, ProcessStartRequestSchema } from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { ProcessService } from './service.js';

export type ProcessRouter = Hono<{ Variables: { requestId: string } }>;

/**
 * `/api/v1/projects/:id/processes/*` (D301, design §6.3). Mounted inside the gateway's token,
 * Origin and request-id middleware; answers 501 when the engine was built without a terminal
 * (D121).
 */
export function createProcessRoutes(processService: ProcessService | undefined): ProcessRouter {
  const router: ProcessRouter = new Hono<{ Variables: { requestId: string } }>();
  const processes = (): ProcessService => {
    if (processService === undefined) throw notImplemented('The terminal');
    return processService;
  };
  const base = '/projects/:id/processes';

  // Registered before `/:procId`, which would otherwise read "scripts" as a process id.
  router.get(`${base}/scripts`, async (c) => c.json(await processes().scripts(c.req.param('id'))));

  router.get(base, async (c) => c.json(await processes().list(c.req.param('id'))));

  router.post(base, async (c) => {
    const service = processes();
    const body = ProcessStartRequestSchema.parse(await readJson(c));
    return c.json(await service.start(c.req.param('id'), body), 201);
  });

  router.get(`${base}/:procId`, async (c) =>
    c.json(await processes().get(c.req.param('id'), c.req.param('procId'))),
  );

  router.post(`${base}/:procId/input`, async (c) => {
    const service = processes();
    const { data } = ProcessInputRequestSchema.parse(await readJson(c));
    await service.input(c.req.param('id'), c.req.param('procId'), data);
    return c.body(null, 204);
  });

  router.post(`${base}/:procId/stop`, async (c) => {
    await processes().stop(c.req.param('id'), c.req.param('procId'));
    return c.body(null, 204);
  });

  return router;
}
