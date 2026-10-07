import { CreateSecretRequestSchema, UpdateSecretRequestSchema } from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { SecretService } from './index.js';

/**
 * `/secrets` (ACE parity P1, D274): list `{ items }`, create 201, update, delete 204 — the knowledge
 * routes' shapes (D64). No answer ever carries a value: the service returns rows, and a row has no
 * value field (`SecretSchema` is strict). A body is parsed by its contract, which also refuses a
 * name that would shadow the shell or the engine (`RESERVED_SECRET_NAMES`).
 *
 * Built without a secret service, every route answers 501 `not_implemented` (D121).
 */

export type SecretRouter = Hono<{ Variables: { requestId: string } }>;

export function createSecretRoutes(secretService: SecretService | undefined): SecretRouter {
  const router: SecretRouter = new Hono<{ Variables: { requestId: string } }>();

  const secrets = (): SecretService => {
    if (secretService === undefined) throw notImplemented('secrets');
    return secretService;
  };

  router.get('/secrets', async (c) => c.json({ items: await secrets().list() }));

  // Each handler resolves its service before it reads the body: no service is 501 whatever the
  // body says, as the knowledge routes answer.
  router.post('/secrets', async (c) => {
    const service = secrets();
    const body = CreateSecretRequestSchema.parse(await readJson(c));
    return c.json(await service.create(body), 201);
  });

  router.patch('/secrets/:name', async (c) => {
    const service = secrets();
    const patch = UpdateSecretRequestSchema.parse(await readJson(c));
    return c.json(await service.update(c.req.param('name'), patch));
  });

  router.delete('/secrets/:name', async (c) => {
    await secrets().remove(c.req.param('name'));
    return c.body(null, 204);
  });

  return router;
}
