import { RetryRequestSchema, RerunRequestSchema } from '@ace/contracts';
import { Hono, type Env } from 'hono';

import { notImplemented } from '../../gateway/errors.js';
import { readJson as readBody } from '../../gateway/read-json.js';
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
 *   POST /runs/:id/replay                              → Run    (PG-5.4, a new run, `replayOf`)
 *   POST /runs/:id/continue                            → Run    (D388, the same run, re-opened)
 *   POST /node-runs/:id/retry                          → NodeRun (attempt + 1)
 *   POST /runs/:id/nodes/:nodeId/rerun                 → NodeRun
 */

/**
 * `resolve` is a getter rather than the service itself so that a harness can build an app before
 * the controls exist, and so that an app built without them answers `not_implemented` rather than
 * crashing — the same answer the gateway already gives for the round-2 services it was built
 * without.
 */
export function createRunControlRoutes<E extends Env>(
  resolve: () => RunControls | undefined,
): Hono<E> {
  const routes = new Hono<E>();

  const controls = (): RunControls => {
    const service = resolve();
    if (service === undefined) throw notImplemented('run controls');
    return service;
  };

  routes.post('/runs/:id/pause', async (c) => c.json(await controls().pause(c.req.param('id'))));
  routes.post('/runs/:id/resume', async (c) => c.json(await controls().resume(c.req.param('id'))));
  routes.post('/runs/:id/stop', async (c) => c.json(await controls().stop(c.req.param('id'))));

  // The **new** run, with `restartedFromRunId` (§2.5). 201, like every other create.
  routes.post('/runs/:id/restart', async (c) =>
    c.json(await controls().restart(c.req.param('id')), 201),
  );

  // D388: the **same** run, re-opened to carry on from what was cut off — 200, nothing is created
  // but the retries inside it. 409 `invalid_run_state` / `nothing_to_continue` otherwise.
  routes.post('/runs/:id/continue', async (c) =>
    c.json(await controls().continueRun(c.req.param('id'))),
  );

  // PG-5.4: the **new** run, with `replayOf`, answered from the recording — zero provider calls.
  routes.post('/runs/:id/replay', async (c) => {
    const service = controls();
    if (service.replay === undefined) throw notImplemented('run replay');
    return c.json(await service.replay(c.req.param('id')), 201);
  });

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
