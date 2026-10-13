import { CheckpointActionSchema, RequiredFilePathQuerySchema } from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { CheckpointService } from './service.js';

export type CheckpointRouter = Hono<{ Variables: { requestId: string } }>;

/**
 * `/api/v1/projects/:id/checkpoints/*` (D300, design §5.3). Mounted inside the gateway's token,
 * Origin and request-id middleware; answers 501 when the engine was built without checkpoints
 * (D121).
 */
export function createCheckpointRoutes(service: CheckpointService | undefined): CheckpointRouter {
  const router: CheckpointRouter = new Hono<{ Variables: { requestId: string } }>();
  const checkpoints = (): CheckpointService => {
    if (service === undefined) throw notImplemented('Checkpoints');
    return service;
  };
  const base = '/projects/:id/checkpoints';

  router.get(base, async (c) => c.json(await checkpoints().list(c.req.param('id'))));

  router.get(`${base}/:checkpointId`, async (c) =>
    c.json(await checkpoints().get(c.req.param('id'), c.req.param('checkpointId'))),
  );

  router.get(`${base}/:checkpointId/diff`, async (c) => {
    const service = checkpoints();
    const { path } = RequiredFilePathQuerySchema.parse(c.req.query());
    return c.json(await service.fileDiff(c.req.param('id'), c.req.param('checkpointId'), path));
  });

  router.post(`${base}/:checkpointId/actions`, async (c) => {
    const service = checkpoints();
    const body = CheckpointActionSchema.parse(await readJson(c));
    return c.json(await service.act(c.req.param('id'), c.req.param('checkpointId'), body));
  });

  return router;
}
