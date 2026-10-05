import {
  HealthMetricsSchema,
  TraceResponseSchema,
  UsageResponseSchema,
  type UsageQuery,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import { createTraceService, type TraceService } from '../../trace/index.js';
import { createUsageService, type UsageService } from '../index.js';
import { createUsageRoutes } from '../routes.js';

/**
 * The observability routes of round 5 §2.6 / §2.9 (FR-OBS-001, FR-OBS-004, FR-OBS-007): the trace
 * as a bare array (404 for an unknown run), `/usage` with `groupBy` repeated or single and every
 * query parsed by `UsageQuerySchema` (400), the health metrics, and 501 without a service (D121).
 */

const RUN = '01JBXQ8Z9KQ4R7N2VWXYZ0RVN1';

const trace: TraceService = {
  async trace(runId) {
    return [
      {
        seq: 1,
        at: '2026-10-05T09:00:00.000Z',
        kind: 'run_event',
        label: `run.started ${runId}`,
        detail: {},
      },
    ];
  },
};

/** The real usage service over the in-memory repository, recording the queries it was handed. */
function recordingUsage(): UsageService & { queries: UsageQuery[] } {
  const queries: UsageQuery[] = [];
  const real = createUsageService({ usage: new FakeRepository().usage, scope: LOCAL_SCOPE });
  return {
    queries,
    usage: async (query) => {
      queries.push(query);
      return real.usage(query);
    },
    dayTotals: (day) => real.dayTotals(day),
    health: () => real.health(),
  };
}

describe('FR-OBS-001 GET /runs/:id/trace', () => {
  it('answers the trace as a bare TraceEntry[]', async () => {
    const app = routeApp(createUsageRoutes(trace, undefined));

    const response = await send(app, 'GET', `/runs/${RUN}/trace`);

    expect(response.status).toBe(200);
    expect(TraceResponseSchema.parse(await response.json())).toEqual([
      expect.objectContaining({ seq: 1, label: `run.started ${RUN}` }),
    ]);
  });

  it('an unknown run is 404', async () => {
    const real = createTraceService({ repository: new FakeRepository(), scope: LOCAL_SCOPE });
    const app = routeApp(createUsageRoutes(real, undefined));

    const response = await send(app, 'GET', `/runs/${RUN}/trace`);

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });
});

describe('FR-OBS-004 GET /usage', () => {
  it('reads groupBy repeated or single, and from/to, into the query', async () => {
    const usage = recordingUsage();
    const app = routeApp(createUsageRoutes(undefined, usage));
    const from = '2026-10-01T00:00:00.000Z';
    const to = '2026-10-06T00:00:00.000Z';

    const repeated = await send(
      app,
      'GET',
      `/usage?groupBy=provider&groupBy=day&from=${from}&to=${to}`,
    );
    const single = await send(app, 'GET', '/usage?groupBy=model');

    expect(repeated.status).toBe(200);
    expect(UsageResponseSchema.parse(await repeated.json())).toEqual({
      buckets: [],
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
    expect(single.status).toBe(200);
    expect(usage.queries).toEqual([
      { from, to, groupBy: ['provider', 'day'] },
      { groupBy: ['model'] },
    ]);
  });

  it('refuses a missing or unknown grouping, a grouping twice, a bad time and from ≥ to with 400', async () => {
    const usage = recordingUsage();
    const app = routeApp(createUsageRoutes(undefined, usage));

    for (const query of [
      '',
      '?groupBy=colour',
      '?groupBy=day&groupBy=day',
      '?groupBy=day&from=yesterday',
      '?groupBy=day&from=2026-10-06T00:00:00.000Z&to=2026-10-01T00:00:00.000Z',
    ]) {
      const response = await send(app, 'GET', `/usage${query}`);
      expect(response.status, query).toBe(400);
      expect(await errorCode(response)).toBe('validation_failed');
    }
    expect(usage.queries).toEqual([]);
  });
});

describe('FR-OBS-007 GET /metrics/health', () => {
  it('answers HealthMetrics with every error kind named', async () => {
    const app = routeApp(createUsageRoutes(undefined, recordingUsage()));

    const response = await send(app, 'GET', '/metrics/health');

    expect(response.status).toBe(200);
    const health = HealthMetricsSchema.parse(await response.json());
    expect(health.runs).toEqual({ started: 0, completed: 0, halted: 0, blocked: 0 });
    expect(Object.values(health.nodeFailuresByKind).every((count) => count === 0)).toBe(true);
  });
});

describe('D121 an observability route whose service is absent answers 501', () => {
  it('answers 501 before reading the query: a malformed query without the service is still 501', async () => {
    const app = routeApp(createUsageRoutes(undefined, undefined));
    for (const query of ['', '?groupBy=colour', '?groupBy=day&from=yesterday']) {
      const response = await send(app, 'GET', `/usage${query}`);
      expect(response.status, query).toBe(501);
      expect(await errorCode(response)).toBe('not_implemented');
    }
  });

  it('the trace without the trace service, usage and health without the usage service', async () => {
    const app = routeApp(createUsageRoutes(undefined, undefined));
    for (const path of [`/runs/${RUN}/trace`, '/usage?groupBy=day', '/metrics/health']) {
      const response = await send(app, 'GET', path);
      expect(response.status, path).toBe(501);
      expect(await errorCode(response)).toBe('not_implemented');
    }
  });
});
