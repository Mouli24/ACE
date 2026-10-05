import { UsageQuerySchema } from '@ace/contracts';
import { Hono, type Context } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import type { TraceService } from '../trace/index.js';
import type { UsageService } from './index.js';

/**
 * The observability routes (round 5 §2.6, §2.9, FR-OBS-001, FR-OBS-004, FR-OBS-007):
 *
 * - `GET /runs/:id/trace` — a **bare** `TraceEntry[]` folded from the run's event log, ascending
 *   `seq` (F9, D235); an unknown run is the trace service's 404.
 * - `GET /usage?from&to&groupBy` — `UsageResponse`. `groupBy` is read as a repeatable parameter, so
 *   `?groupBy=provider&groupBy=day` and a single `?groupBy=day` both parse (D234).
 * - `GET /metrics/health` — `HealthMetrics`.
 *
 * Each service may be `undefined`: its routes then answer 501 `not_implemented` (D121).
 */

export type UsageRouter = Hono<{ Variables: { requestId: string } }>;

/** The query string as `UsageQuerySchema` reads it, `groupBy` collected from every repetition. */
function usageQuery(c: Context): unknown {
  const raw: Record<string, unknown> = {};
  const from = c.req.query('from');
  const to = c.req.query('to');
  const groupBy = c.req.queries('groupBy');
  if (from !== undefined) raw['from'] = from;
  if (to !== undefined) raw['to'] = to;
  if (groupBy !== undefined) raw['groupBy'] = groupBy;
  return raw;
}

export function createUsageRoutes(
  traceService: TraceService | undefined,
  usageService: UsageService | undefined,
): UsageRouter {
  const router: UsageRouter = new Hono<{ Variables: { requestId: string } }>();

  const trace = (): TraceService => {
    if (traceService === undefined) throw notImplemented('run traces');
    return traceService;
  };

  const usage = (): UsageService => {
    if (usageService === undefined) throw notImplemented('usage');
    return usageService;
  };

  router.get('/runs/:id/trace', async (c) => c.json(await trace().trace(c.req.param('id'))));

  router.get('/usage', async (c) => {
    // The service first: no service is 501 whatever the query says.
    const service = usage();
    const query = UsageQuerySchema.parse(usageQuery(c));
    return c.json(await service.usage(query));
  });

  router.get('/metrics/health', async (c) => c.json(await usage().health()));

  return router;
}
