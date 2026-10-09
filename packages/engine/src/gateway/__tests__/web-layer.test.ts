import { ApiErrorSchema } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { createGraphService } from '../../graph/index.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type Auth, type Scope } from '../../ports/index.js';
import { createEngineApp, isWebRequest, type EngineDeps } from '../index.js';

/*
 * D297: where the web app sits in the middleware chain. The handler itself (files, fallback,
 * caching, traversal) is `apps/server`'s and is tested there against a real folder; here a stub
 * stands in for it, so what is pinned is the gateway's part — which requests reach it, and that
 * the origin guard still runs first while the token check does not.
 */

const TOKEN = 'c3'.repeat(32);
const SELF_ORIGIN = 'http://127.0.0.1:51234';
const auth: Auth = { verifyToken: async (_scope: Scope, token?: string) => token === TOKEN };

function app(web?: EngineDeps['web']) {
  const repository = new FakeRepository();
  const logger = createLogger({ level: 'fatal', destination: { write: () => undefined } });
  return createEngineApp({
    repository,
    auth,
    logger,
    scope: LOCAL_SCOPE,
    version: '0.1.0',
    graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
    selfOrigins: [SELF_ORIGIN],
    ...(web === undefined ? {} : { web }),
  });
}

const stub: EngineDeps['web'] = async (c) => c.html('<!doctype html><title>ACE</title>');

describe('FR-DSK-002 isWebRequest (D297)', () => {
  it.each([
    ['GET', '/', true],
    ['HEAD', '/', true],
    ['GET', '/projects/abc', true],
    ['GET', '/assets/index-abc123.js', true],
    ['GET', '/api', true],
    ['GET', '/api/v10/x', true],
    ['GET', '/api/v1', false],
    ['GET', '/api/v1/health', false],
    ['GET', '/ws', false],
    ['GET', '/ws/anything', false],
    ['POST', '/', false],
    ['PATCH', '/projects/abc', false],
    ['OPTIONS', '/', false],
  ])('%s %s → %s', (method, path, expected) => {
    expect(isWebRequest(method, path)).toBe(expected);
  });
});

describe('FR-SYS-002 / FR-SYS-003 the web layer in the chain (D297)', () => {
  it('a page needs no token', async () => {
    const res = await app(stub).request('/projects/abc');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>ACE</title>');
  });

  it('every API route still needs the token, health included', async () => {
    const res = await app(stub).request('/api/v1/health');
    expect(res.status).toBe(401);
    ApiErrorSchema.parse(await res.json());
  });

  it('an unknown API route is still the JSON 404, behind the token', async () => {
    const withToken = await app(stub).request('/api/v1/nope', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(withToken.status).toBe(404);
    expect(ApiErrorSchema.parse(await withToken.json()).error.code).toBe('not_found');
    expect((await app(stub).request('/api/v1/nope')).status).toBe(401);
  });

  it('the origin guard runs before the web app: a foreign page cannot load it', async () => {
    const foreign = await app(stub).request('/', { headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    const own = await app(stub).request('/', { headers: { origin: SELF_ORIGIN } });
    expect(own.status).toBe(200);
  });

  it('a write to a page path is not a page: it meets the token check', async () => {
    expect((await app(stub).request('/', { method: 'POST' })).status).toBe(401);
  });

  it('without a web app nothing changes: a page path is a 401', async () => {
    expect((await app().request('/')).status).toBe(401);
    expect((await app().request('/projects/abc')).status).toBe(401);
  });
});
