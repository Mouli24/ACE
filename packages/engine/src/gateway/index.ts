import {
  API_BASE_PATH,
  CreateProjectRequestSchema,
  CreateProviderRequestSchema,
  CreateWorkflowRequestSchema,
  CursorQuerySchema,
  EventsQuerySchema,
  HealthResponseSchema,
  ModelQuerySchema,
  SettingsPatchSchema,
  StartRunRequestSchema,
  UpdateProjectRequestSchema,
  UpdateProviderRequestSchema,
  UpdateWorkflowRequestSchema,
} from '@ace/contracts';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { GraphService } from '../graph/index.js';
import type { ProviderService } from '../providers/index.js';
import type { Auth, Repository, Scope } from '../ports/index.js';
import type { RunService } from '../runs/index.js';
import {
  forbiddenOrigin,
  notFound,
  notImplemented,
  providerInUse,
  toApiError,
  unauthorized,
} from './errors.js';

export interface EngineDeps {
  repository: Repository;
  auth: Auth;
  logger: Logger;
  scope: Scope;
  /** Reported by `GET /health`. */
  version: string;
  graph: GraphService;
  /** The engine's own origin, always allowed in addition to `settings.allowedOrigins`. */
  selfOrigins?: string[];

  /* Round 2. Optional so a round 1 harness still builds an app without them. */
  providers?: ProviderService;
  runs?: RunService;
  bus?: EventBus;
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
 * The browser half of FR-SYS-003.
 *
 * `originGuard` below decides whether a request may come *in*; this decides whether the browser is
 * allowed to hand the answer *back* to the page. Both are needed: without the header a browser
 * throws away an otherwise perfectly good 200, which is what a page sees as `Failed to fetch`.
 *
 * Mounted ahead of `authGuard` on purpose. A CORS preflight carries no `Authorization` header — the
 * browser is asking permission *before* it is willing to send credentials — so a token check in
 * front of it would 401 every preflight and no cross-origin request would ever be made.
 */
function corsLayer(deps: EngineDeps): MiddlewareHandler<{ Variables: EngineVariables }> {
  return cors({
    // Deliberately the same two sources `originGuard` reads, so the pair can never disagree: an
    // origin added to settings would otherwise pass the guard and still be blocked by the browser.
    origin: async (origin) => {
      const settings = await deps.repository.settings.get(deps.scope);
      const allowed = new Set([...settings.allowedOrigins, ...(deps.selfOrigins ?? [])]);
      return allowed.has(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    maxAge: 600,
  });
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
  app.use('*', corsLayer(deps));
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

  /* ------------------------------------------------------------- projects */

  const page = (c: Context): ReturnType<typeof CursorQuerySchema.parse> =>
    CursorQuerySchema.parse(c.req.query());

  /**
   * Round 2's services. A round 1 app is built without them, and a request that needs one gets
   * `not_implemented` rather than a crash — the same answer the gateway already gives for a
   * feature that has not landed.
   */
  const providers = (_c: Context): ProviderService => {
    if (deps.providers === undefined) throw notImplemented('providers');
    return deps.providers;
  };

  const runs = (_c: Context): RunService => {
    if (deps.runs === undefined) throw notImplemented('runs');
    return deps.runs;
  };

  api.get('/projects', async (c) => c.json(await deps.graph.listProjects(page(c))));

  api.post('/projects', async (c) => {
    const input = CreateProjectRequestSchema.parse(await readJson(c));
    return c.json(await deps.graph.createProject(input), 201);
  });

  api.get('/projects/:id', async (c) => c.json(await deps.graph.getProject(c.req.param('id'))));

  api.patch('/projects/:id', async (c) => {
    const { name } = UpdateProjectRequestSchema.parse(await readJson(c));
    const id = c.req.param('id');
    return c.json(name === undefined ? await deps.graph.getProject(id) : await deps.graph.renameProject(id, name));
  });

  api.delete('/projects/:id', async (c) => {
    await deps.graph.deleteProject(c.req.param('id'));
    return c.body(null, 204);
  });

  api.post('/projects/:id/open', async (c) => c.json(await deps.graph.openProject(c.req.param('id'))));

  /* ------------------------------------------------------------ workflows */

  api.get('/projects/:id/workflows', async (c) =>
    c.json(await deps.graph.listWorkflows(c.req.param('id'), page(c))),
  );

  api.post('/projects/:id/workflows', async (c) => {
    const { name } = CreateWorkflowRequestSchema.parse(await readJson(c));
    return c.json(await deps.graph.createWorkflow(c.req.param('id'), name), 201);
  });

  api.post('/projects/:id/workflows/import', async (c) =>
    c.json(await deps.graph.importWorkflow(c.req.param('id'), await readJson(c)), 201),
  );

  api.get('/workflows/:id', async (c) => c.json(await deps.graph.getWorkflowGraph(c.req.param('id'))));

  api.patch('/workflows/:id', async (c) => {
    const { name } = UpdateWorkflowRequestSchema.parse(await readJson(c));
    const id = c.req.param('id');
    if (name === undefined) return c.json((await deps.graph.getWorkflowGraph(id)).workflow);
    return c.json(await deps.graph.renameWorkflow(id, name));
  });

  api.delete('/workflows/:id', async (c) => {
    await deps.graph.deleteWorkflow(c.req.param('id'));
    return c.body(null, 204);
  });

  api.post('/workflows/:id/duplicate', async (c) =>
    c.json(await deps.graph.duplicateWorkflow(c.req.param('id')), 201),
  );

  api.post('/workflows/:id/graph-ops', async (c) =>
    c.json(await deps.graph.applyGraphOps(c.req.param('id'), await readJson(c))),
  );

  api.post('/workflows/:id/validate', async (c) =>
    c.json({ issues: await deps.graph.validateWorkflow(c.req.param('id')) }),
  );

  api.get('/workflows/:id/export', async (c) =>
    c.json(await deps.graph.exportWorkflow(c.req.param('id'))),
  );


  /* ------------------------------------------------------------- providers */

  /**
   * Registered before `/providers/:id`, because `detect` is a word and `:id` would swallow it
   * (FR-PRV-007).
   */
  api.get('/providers/detect', async (c) => c.json(await providers(c).detect()));

  // Wrapped like every other collection (`/projects`, `/models`, `/workflows/:id/runs`); D64.
  api.get('/providers', async (c) => c.json({ items: await providers(c).list() }));

  api.post('/providers', async (c) => {
    const input = CreateProviderRequestSchema.parse(await readJson(c));
    return c.json(await providers(c).create(input), 201);
  });

  api.get('/providers/:id', async (c) => {
    const provider = await providers(c).get(c.req.param('id'));
    if (provider === null) throw notFound(`provider ${c.req.param('id')}`);
    return c.json(provider);
  });

  api.patch('/providers/:id', async (c) => {
    const patch = UpdateProviderRequestSchema.parse(await readJson(c));
    const provider = await providers(c).update(c.req.param('id'), patch);
    if (provider === null) throw notFound(`provider ${c.req.param('id')}`);
    return c.json(provider);
  });

  api.delete('/providers/:id', async (c) => {
    // FR-PRV-005: without `confirm=true` a provider a node still names is refused, and the
    // refusal carries the node ids so the UI can say exactly what it would break.
    const confirm = c.req.query('confirm') === 'true';
    const result = await providers(c).remove(c.req.param('id'), { confirm });

    if (!result.ok) throw providerInUse(result.nodeIds);
    return c.body(null, 204);
  });

  api.post('/providers/:id/check', async (c) => c.json(await providers(c).check(c.req.param('id'))));

  api.post('/providers/:id/refresh-models', async (c) =>
    c.json(await providers(c).refreshModels(c.req.param('id'))),
  );

  api.get('/models', async (c) => {
    const query = ModelQuerySchema.parse(c.req.query());
    const items = await providers(c).listModels(query);
    const refreshedAt =
      items.reduce<string | undefined>(
        (latest, model) =>
          latest === undefined || model.lastCheckedAt > latest ? model.lastCheckedAt : latest,
        undefined,
      ) ?? new Date(0).toISOString();

    return c.json({ items, refreshedAt });
  });

  /* ------------------------------------------------------------------ runs */

  api.post('/workflows/:id/runs', async (c) => {
    const request = StartRunRequestSchema.parse(await readJson(c));
    // 201 even when pre-flight blocks it: a blocked run is a recorded run (§2.5, FR-EXE-003).
    // Answered as soon as the run is recorded and pre-flighted, never at its end: the client
    // subscribes after this response, and `node.token` is never replayed (§2.4, §5 item 6).
    const { run } = await runs(c).beginRun(c.req.param('id'), request);
    return c.json(run, 201);
  });

  api.get('/workflows/:id/runs', async (c) =>
    c.json(await runs(c).listRuns(c.req.param('id'), page(c))),
  );

  api.get('/runs/:id', async (c) => c.json(await runs(c).getRun(c.req.param('id'))));

  api.get('/runs/:id/node-runs', async (c) => c.json(await runs(c).listNodeRuns(c.req.param('id'))));

  api.get('/runs/:id/events', async (c) => {
    const { afterSeq } = EventsQuerySchema.parse(c.req.query());
    const runId = c.req.param('id');

    // Scoped to this run in the query, not filtered in memory afterwards (FR-EXE-014).
    const events = await deps.repository.events.listAfter(deps.scope, afterSeq ?? 0, {
      runIds: [runId],
    });

    return c.json(
      events
        .map((event) => ({
          seq: event.seq,
          at: event.createdAt,
          ...(event.runId === undefined ? {} : { runId: event.runId }),
          ...(event.workflowId === undefined ? {} : { workflowId: event.workflowId }),
          type: event.type,
          payload: event.payload,
        })),
    );
  });

  api.get('/node-runs/:id', async (c) => c.json(await runs(c).getNodeRun(c.req.param('id'))));

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
