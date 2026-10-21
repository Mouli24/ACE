import { ApiErrorSchema } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { createGraphService } from '../../graph/index.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import { createEngineApp, isHostAllowed, isOriginAllowed, type EngineApp } from '../index.js';

describe('FR-SYS-003 D301 one Origin rule for REST and the WebSocket', () => {
  const deps = {
    repository: new FakeRepository(),
    scope: LOCAL_SCOPE,
    selfOrigins: ['http://127.0.0.1:47490', 'http://localhost:47490'],
  };

  it.each([
    [undefined, true],
    ['', true],
    ['http://localhost:5173', true],
    ['http://127.0.0.1:5173', true],
    ['http://127.0.0.1:47490', true],
    ['http://localhost:47490', true],
    ['https://evil.example', false],
    ['http://localhost:5174', false],
    ['null', false],
  ] as const)('Origin %j is allowed: %s', async (origin, allowed) => {
    expect(await isOriginAllowed(deps, origin)).toBe(allowed);
  });

  it('follows the stored allow-list, not a hard-coded one', async () => {
    const repository = new FakeRepository();
    await repository.settings.update(LOCAL_SCOPE, { allowedOrigins: ['https://ace.example'] });
    const own = { repository, scope: LOCAL_SCOPE };
    expect(await isOriginAllowed(own, 'https://ace.example')).toBe(true);
    expect(await isOriginAllowed(own, 'http://localhost:5173')).toBe(false);
  });
});

describe('[audit S-7] the Host header must name the engine itself', () => {
  const selfHosts = ['127.0.0.1:47490', 'localhost:47490', '[::1]:47490'];
  const token = 'c3'.repeat(32);

  function app(hosts?: string[]): EngineApp {
    const repository = new FakeRepository();
    const logger = createLogger({ level: 'silent' });
    return createEngineApp({
      repository,
      auth: { verifyToken: async (_scope, given) => given === token },
      logger,
      scope: LOCAL_SCOPE,
      version: '0.1.0',
      graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
      ...(hosts === undefined ? {} : { selfHosts: hosts }),
    });
  }

  it.each([
    ['127.0.0.1:47490', true],
    ['localhost:47490', true],
    ['LOCALHOST:47490', true],
    ['[::1]:47490', true],
    ['evil.example:47490', false],
    ['127.0.0.1:47491', false],
    ['127.0.0.1', false],
    [undefined, false],
  ] as const)('Host %j is allowed: %s', (host, allowed) => {
    expect(isHostAllowed(selfHosts, host)).toBe(allowed);
  });

  it('checks nothing when the app has no address of its own', () => {
    expect(isHostAllowed(undefined, 'evil.example')).toBe(true);
  });

  it('refuses a rebound page’s request with 403 before auth or CORS, and serves its own host', async () => {
    const engine = app(selfHosts);
    const headers = { Authorization: `Bearer ${token}` };

    const rebound = await engine.request('http://evil.example:47490/api/v1/health', {
      headers: { ...headers, Host: 'evil.example:47490' },
    });
    const preflight = await engine.request('http://evil.example:47490/api/v1/health', {
      method: 'OPTIONS',
      headers: { Host: 'evil.example:47490', Origin: 'http://evil.example:47490' },
    });
    const own = await engine.request('http://127.0.0.1:47490/api/v1/health', {
      headers: { ...headers, Host: '127.0.0.1:47490' },
    });

    expect(rebound.status).toBe(403);
    expect(ApiErrorSchema.parse(await rebound.json()).error.code).toBe('forbidden_origin');
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(own.status).toBe(200);
  });
});
