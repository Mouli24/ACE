import { AssistantApplyRequestSchema, AssistantProposeRequestSchema } from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { AssistantService } from './service.js';

/**
 * `POST /assistant/propose` (drafts, writes nothing) and `POST /assistant/apply` (the confirmation
 * tick: 201 with the project and the team's workflow) — ACE parity P2, D283.
 */
export type AssistantRouter = Hono<{ Variables: { requestId: string } }>;

export function createAssistantRoutes(assistant: AssistantService | undefined): AssistantRouter {
  const router: AssistantRouter = new Hono<{ Variables: { requestId: string } }>();
  const service = (): AssistantService => {
    if (assistant === undefined) throw notImplemented('the Assistant');
    return assistant;
  };

  router.post('/assistant/propose', async (c) => {
    const s = service();
    const body = AssistantProposeRequestSchema.parse(await readJson(c));
    return c.json(await s.propose(body));
  });

  router.post('/assistant/apply', async (c) => {
    const s = service();
    const body = AssistantApplyRequestSchema.parse(await readJson(c));
    return c.json(await s.apply(body), 201);
  });

  return router;
}
