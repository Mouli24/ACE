import { ApiErrorSchema, TEMPLATE_IDS } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { createGraphService } from '../../graph/index.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type Auth } from '../../ports/index.js';
import { createUsageService } from '../../usage/index.js';
import { TEMPLATE_DEFINITIONS } from '../../templates/service.js';
import { createEngineApp, type EngineDeps } from '../index.js';

/**
 * The round 5 sub-routers mounted on the gateway (Task 13b, §2.9, D121): each one sits inside
 * `/api/v1` behind the same request-id, CORS, origin and auth middleware as every other route — a
 * route that skipped `authGuard` would be a hole in FR-SYS-002 — and an app built without a round 5
 * service answers that service's routes 501 `not_implemented`.
 */

const TOKEN = 'a'.repeat(64);
const auth: Auth = { verifyToken: async (_scope, token) => token === TOKEN };
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
const ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ZZZZ';

function app(extra: Partial<EngineDeps> = {}) {
  const repository = new FakeRepository();
  return createEngineApp({
    repository,
    auth,
    logger,
    scope: LOCAL_SCOPE,
    version: 'test',
    graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
    ...extra,
  });
}

/** One request per round 5 route group: [method, path, body?]. */
const ROUTES: [string, string, unknown?][] = [
  ['GET', `/projects/${ID}/knowledge-bases`],
  ['POST', `/knowledge-bases/${ID}/query`, { query: 'x' }],
  ['GET', `/nodes/${ID}/memory`],
  ['GET', `/runs/${ID}/trace`],
  ['GET', '/usage?groupBy=day'],
  ['GET', '/metrics/health'],
  ['GET', '/templates'],
  ['POST', '/backup/export'],
];

function request(
  built: ReturnType<typeof app>,
  [method, path, body]: [string, string, unknown?],
  token: string | null = TOKEN,
) {
  return built.request(`/api/v1${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('D121 the round 5 routes without their services', () => {
  it.each(ROUTES)('%s %s answers 501 not_implemented', async (method, path, body) => {
    const response = await request(app(), [method, path, body]);

    expect(response.status).toBe(501);
    expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('not_implemented');
  });
});

describe('FR-SYS-002 the round 5 routes are mounted behind the auth guard', () => {
  const repository = new FakeRepository();
  const wired = app({
    knowledge: {
      list: async () => [],
    } as unknown as EngineDeps['knowledge'],
    search: { search: async () => ({ hits: [], tookMs: 0 }) },
    memory: { list: async () => [] } as unknown as EngineDeps['memory'],
    trace: { trace: async () => [] },
    usage: createUsageService({ usage: repository.usage, scope: LOCAL_SCOPE }),
    templates: { list: () => [...TEMPLATE_DEFINITIONS], instantiate: async () => ({}) as never },
    backup: {
      exportZip: async () => new Uint8Array([1]),
      importZip: async () => ({ restored: { projects: 0, runs: 0, artifacts: 0 } }),
    },
  });

  it.each(ROUTES)(
    '%s %s answers 200 with the token and 401 without',
    async (method, path, body) => {
      const allowed = await request(wired, [method, path, body]);
      expect(allowed.status).toBe(200);

      const refused = await request(wired, [method, path, body], null);
      expect(refused.status).toBe(401);
    },
  );

  it('GET /templates through the gateway lists the four', async () => {
    const response = await request(wired, ['GET', '/templates']);
    expect(((await response.json()) as { id: string }[]).map((t) => t.id)).toEqual([
      ...TEMPLATE_IDS,
    ]);
  });
});
