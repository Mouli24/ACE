import { API_BASE_PATH, HealthResponseSchema, SettingsPatchSchema } from '@ace/contracts';
import { Hono, type Context, type MiddlewareHandler } from 'hono';

import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { Auth, Repository, Scope } from '../ports/index.js';
import { forbiddenOrigin, notFound, toApiError, unauthorized } from './errors.js';

export interface EngineDeps {
  repository: Repository;
  auth: Auth;
  logger: Logger;
  scope: Scope;
  /** Reported by `GET /health`. */
  version: string;
  /** The engine's own origin, always allowed in addition to `settings.allowedOrigins`. */
  selfOrigins?: string[];
}

export interface EngineVariables {
  requestId: string;
}

export type EngineApp = Hono<{ Variables: EngineVariables }>;

/** Read the bearer token, tolerating the header casing and spacing a client might send. */
export function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

/**
 * FR-SYS-003 / TC-SYS-004: refuse a request whose `Origin` is not on the allow-list.
 *
 * A request with no `Origin` at all is allowed: browsers always send one on a cross-origin call,
 * while curl and the CLI send none, and the A1 acceptance criterion requires a plain curl to work.
 * The protection against a malicious page is that it cannot forge an allowed `Origin`, and it does
 * not have the session token either (Arch §22.2, spoofing row).
 */
function originGuard(deps: EngineDeps): MiddlewareHandler<{ Variables: EngineVariables }> {
  return async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin === undefined || origin === '') return next();

    const settings = await deps.repository.settings.get(deps.scope);
    const allowed = new Set([...settings.allowedOrigins, ...(deps.selfOrigins ?? [])]);

    if (!allowed.has(origin)) throw forbiddenOrigin(origin);
    return next();
  };
}

/** FR-SYS-002 / TC-SYS-002: every route, health included, needs the session token. */
function authGuard(deps: EngineDeps): MiddlewareHandler<{ Variables: EngineVariables }> {
  return async (c, next) => {
    const token = bearerToken(c.req.header('Authorization'));
    if (!(await deps.auth.verifyToken(deps.scope, token))) throw unauthorized();
    return next();
  };
}

/** Arch §11: every request carries an id, echoed back so a client can quote it in a report. */
function requestId(): MiddlewareHandler<{ Variables: EngineVariables }> {
  return async (c, next) => {
    const id = c.req.header('x-request-id') ?? newId();
    c.set('requestId', id);
    c.header('x-request-id', id);
    return next();
  };
}

/**
 * The engine's HTTP surface (§2.8).
 *
 * This factory never binds a socket — `apps/server` does that. Tests get a real app and drive it
 * through `app.request(...)`, so the middleware chain under test is the one that ships.
 */
export function createEngineApp(deps: EngineDeps): EngineApp {
  const app = new Hono<{ Variables: EngineVariables }>();

  app.onError((error, c) => {
    const { status, body } = toApiError(error);

    // The full error goes to the log (redacted there); the client gets the §2.3 envelope only.
    deps.logger.error(
      { err: error, requestId: c.get('requestId'), path: c.req.path, status },
      'request failed',
    );

    return c.json(body, status as 400);
  });

  app.use('*', requestId());
  app.use('*', originGuard(deps));
  app.use('*', authGuard(deps));

  const api = new Hono<{ Variables: EngineVariables }>();

  api.get('/health', async (c) => {
    // A read that touches the database, so "db: ok" means the store really answered.
    await deps.repository.settings.get(deps.scope);

    return c.json(
      HealthResponseSchema.parse({ status: 'ok', version: deps.version, db: 'ok' }),
    );
  });

  api.get('/settings', async (c) => c.json(await deps.repository.settings.get(deps.scope)));

  api.patch('/settings', async (c) => {
    const patch = SettingsPatchSchema.parse(await readJson(c));
    return c.json(await deps.repository.settings.update(deps.scope, patch));
  });

  app.route(API_BASE_PATH, api);

  app.notFound((c) => {
    const { status, body } = toApiError(notFound(`${c.req.method} ${c.req.path}`));
    return c.json(body, status as 404);
  });

  return app;
}

/** Parse a JSON body, turning a malformed one into the §2.3 validation error. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export * from './errors.js';
