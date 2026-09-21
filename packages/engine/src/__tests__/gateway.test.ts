import { ApiErrorSchema, HealthResponseSchema, SettingsSchema } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createEngineApp, type EngineApp } from '../gateway/index.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE, type Auth, type Repository, type Scope } from '../ports/index.js';
import { FakeRepository } from './fake-repository.js';

const TOKEN = 'a'.repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };

/** Accepts exactly the one issued token, like the real SessionTokenAuth. */
const auth: Auth = {
  verifyToken: async (_scope: Scope, token: string | undefined) => token === TOKEN,
};

let repository: Repository;
let app: EngineApp;

function build(repo: Repository = repository): EngineApp {
  return createEngineApp({
    repository: repo,
    auth,
    // Silent: a test must not print, and the log is not what is under test here.
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    scope: LOCAL_SCOPE,
    version: '0.1.0',
    selfOrigins: ['http://127.0.0.1:4747'],
  });
}

beforeEach(() => {
  repository = new FakeRepository();
  app = build();
});

describe('TC-SYS-005 Health check', () => {
  it('answers 200 with the version and a database status', async () => {
    const response = await app.request('/api/v1/health', { headers: AUTH });

    expect(response.status).toBe(200);
    expect(HealthResponseSchema.parse(await response.json())).toEqual({
      status: 'ok',
      version: '0.1.0',
      db: 'ok',
    });
  });

  it('echoes an x-request-id, and mints one when the client sends none', async () => {
    const echoed = await app.request('/api/v1/health', {
      headers: { ...AUTH, 'x-request-id': 'req-123' },
    });
    const minted = await app.request('/api/v1/health', { headers: AUTH });

    expect(echoed.headers.get('x-request-id')).toBe('req-123');
    expect(minted.headers.get('x-request-id')).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });
});

describe('TC-SYS-002 Missing token', () => {
  it('refuses a request with no Authorization header', async () => {
    const response = await app.request('/api/v1/settings');

    expect(response.status).toBe(401);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.kind).toBe('auth');
  });

  it('refuses a wrong token', async () => {
    const response = await app.request('/api/v1/settings', {
      headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
    });

    expect(response.status).toBe(401);
  });

  it.each([
    ['no scheme', TOKEN],
    ['the wrong scheme', `Basic ${TOKEN}`],
    ['an empty bearer', 'Bearer '],
  ])('refuses %s', async (_label, header) => {
    const response = await app.request('/api/v1/settings', { headers: { Authorization: header } });

    expect(response.status).toBe(401);
  });

  it('protects /health too, which is a route like any other (FR-SYS-002)', async () => {
    const response = await app.request('/api/v1/health');

    expect(response.status).toBe(401);
  });

  it('accepts a lowercase bearer scheme, which some clients send', async () => {
    const response = await app.request('/api/v1/health', {
      headers: { Authorization: `bearer ${TOKEN}` },
    });

    expect(response.status).toBe(200);
  });
});

describe('TC-SYS-004 Foreign origin', () => {
  it('refuses a request from an origin that is not on the allow-list', async () => {
    const response = await app.request('/api/v1/health', {
      headers: { ...AUTH, Origin: 'https://evil.example' },
    });

    expect(response.status).toBe(403);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('forbidden_origin');
  });

  it('allows the web app origin from §2.7 defaults', async () => {
    const response = await app.request('/api/v1/health', {
      headers: { ...AUTH, Origin: 'http://localhost:5173' },
    });

    expect(response.status).toBe(200);
  });

  it("allows the engine's own origin", async () => {
    const response = await app.request('/api/v1/health', {
      headers: { ...AUTH, Origin: 'http://127.0.0.1:4747' },
    });

    expect(response.status).toBe(200);
  });

  it('allows a request with no Origin at all, which is what curl and the CLI send', async () => {
    const response = await app.request('/api/v1/health', { headers: AUTH });

    expect(response.status).toBe(200);
  });

  it('checks the origin before the token, so a foreign page is refused either way', async () => {
    const response = await app.request('/api/v1/health', {
      headers: { Origin: 'https://evil.example' },
    });

    expect(response.status).toBe(403);
  });
});

describe('TC-SYS-006 Settings persist', () => {
  it('returns the §2.7 defaults before anything is changed', async () => {
    const response = await app.request('/api/v1/settings', { headers: AUTH });
    const settings = SettingsSchema.parse(await response.json());

    expect(settings.concurrency).toBe(20);
    expect(settings.theme).toBe('dark');
  });

  it('keeps concurrency 5 across a restart of the engine', async () => {
    const patched = await app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ concurrency: 5 }),
    });
    expect(patched.status).toBe(200);

    // A restart is a new app over the same store.
    const restarted = build(repository);
    const settings = SettingsSchema.parse(
      await (await restarted.request('/api/v1/settings', { headers: AUTH })).json(),
    );

    expect(settings.concurrency).toBe(5);
    expect(settings.theme).toBe('dark');
  });

  it('refuses a settings patch outside the allowed range', async () => {
    const response = await app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ concurrency: 999 }),
    });

    expect(response.status).toBe(400);
    expect(ApiErrorSchema.parse(await response.json()).error.code).toBe('validation_failed');
  });
});

describe('TC-SYS-007 Error format', () => {
  it.each([
    [
      400,
      'validation_failed',
      () =>
        app.request('/api/v1/settings', {
          method: 'PATCH',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ theme: 'chartreuse' }),
        }),
    ],
    [401, 'unauthorized', () => app.request('/api/v1/settings')],
    [404, 'not_found', () => app.request('/api/v1/nope', { headers: AUTH })],
  ])('a %i answers the §2.3 envelope with code %s', async (status, code, send) => {
    const response = await send();

    expect(response.status).toBe(status);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe('string');
    expect(typeof body.error.retryable).toBe('boolean');
  });

  it('turns an unexpected throw into a 500 that leaks nothing', async () => {
    const exploding: Repository = new FakeRepository();
    exploding.settings.get = async () => {
      throw new Error('ENOENT: /home/arhant/.ace/secret-path/ace.sqlite');
    };

    const response = await build(exploding).request('/api/v1/health', { headers: AUTH });

    expect(response.status).toBe(500);
    const body = ApiErrorSchema.parse(await response.json());
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('secret-path');
  });
});
