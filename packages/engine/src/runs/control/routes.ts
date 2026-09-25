import { RetryRequestSchema, RerunRequestSchema } from '@ace/contracts';
import { Hono, type Context, type Env } from 'hono';

import type { RunControls } from './service.js';

/**
 * The round 3 control endpoints (§2.5), as a router the gateway mounts in one line.
 *
 * A separate module rather than more handlers in `gateway/index.ts`: the gateway is one file four
 * features are landing in this round, and a router that can be mounted keeps this feature's HTTP
 * surface reviewable on its own. The generic `Env` is what lets it mount onto the engine's app
 * without importing it — importing `EngineVariables` from the gateway would close a cycle, because
 * the gateway imports the run service, which exports this.
 *
 *   POST /runs/:id/pause · /resume · /stop · /restart  → Run    (409 `invalid_run_state` otherwise)
 *   POST /node-runs/:id/retry                          → NodeRun (attempt + 1)
 *   POST /runs/:id/nodes/:nodeId/rerun                 → NodeRun
 */

/** A malformed body is an empty one, exactly as the gateway's own `readJson` treats it. */
async function readBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export function createRunControlRoutes<E extends Env>(
  controls: () => RunControls,
): Hono<E> {
  const routes = new Hono<E>();

  routes.post('/runs/:id/pause', async (c) => c.json(await controls().pause(c.req.param('id'))));
  routes.post('/runs/:id/resume', async (c) => c.json(await controls().resume(c.req.param('id'))));
  routes.post('/runs/:id/stop', async (c) => c.json(await controls().stop(c.req.param('id'))));

  // The **new** run, with `restartedFromRunId` (§2.5). 201, like every other create.
  routes.post('/runs/:id/restart', async (c) =>
    c.json(await controls().restart(c.req.param('id')), 201),
  );

  routes.post('/runs/:id/nodes/:nodeId/rerun', async (c) => {
    RerunRequestSchema.parse(await readBody(c));
    return c.json(await controls().rerunNode(c.req.param('id'), c.req.param('nodeId')), 201);
  });

  routes.post('/node-runs/:id/retry', async (c) => {
    const request = RetryRequestSchema.parse(await readBody(c));
    return c.json(await controls().retryNodeRun(c.req.param('id'), request), 201);
  });

  return routes;
}
