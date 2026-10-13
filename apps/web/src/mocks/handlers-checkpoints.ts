import { CheckpointActionSchema, aceError } from '@ace/contracts';
import { http, HttpResponse, type HttpHandler, type PathParams } from 'msw';

import { MockCheckpointError, type MockCheckpoints } from './checkpoints';
import type { MockDb } from './db';

/**
 * Checkpoint routes on the mock engine (D300, design §5.3), over `MockCheckpoints`: the list, one
 * checkpoint, one file's diff, and keep / revert.
 */

const API = '*/api/v1';

type Ctx = { request: Request; params: PathParams };

const hasToken = (request: Request): boolean =>
  /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');

/** The engine's kinds: a state the request met (404, 409, 503) is `workflow`, a refusal `invalid_config`. */
function fail(status: number, code: string, message: string, details?: unknown): Response {
  const kind =
    status === 401
      ? 'auth'
      : code === 'not_found' || status === 409 || status === 503
        ? 'workflow'
        : 'invalid_config';
  return HttpResponse.json(aceError(kind, code, message, { details, retryable: false }), {
    status,
  });
}

export function createCheckpointHandlers(db: MockDb, checkpoints: MockCheckpoints): HttpHandler[] {
  const route =
    (handle: (projectId: string, ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request))
        return fail(401, 'unauthorized', 'Missing or invalid session token.');
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      const projectId = String(ctx.params.id ?? '');
      if (db.getProject(projectId) === undefined)
        return fail(404, 'not_found', 'Project not found.');
      try {
        return await handle(projectId, ctx);
      } catch (error) {
        if (error instanceof MockCheckpointError) {
          return fail(error.status, error.code, error.message, error.details);
        }
        throw error;
      }
    };
  const base = `${API}/projects/:id/checkpoints`;
  const checkpointId = (ctx: Ctx): string => String(ctx.params.checkpointId ?? '');

  return [
    http.get(
      base,
      route((projectId) => HttpResponse.json(checkpoints.list(projectId))),
    ),

    http.get(
      `${base}/:checkpointId`,
      route((projectId, ctx) => HttpResponse.json(checkpoints.get(projectId, checkpointId(ctx)))),
    ),

    http.get(
      `${base}/:checkpointId/diff`,
      route((projectId, ctx) => {
        const path = new URL(ctx.request.url).searchParams.get('path') ?? '';
        if (path === '') return fail(400, 'validation_failed', 'Request query is invalid.');
        return HttpResponse.json(checkpoints.diff(projectId, checkpointId(ctx), path));
      }),
    ),

    http.post(
      `${base}/:checkpointId/actions`,
      route(async (projectId, ctx) => {
        const parsed = CheckpointActionSchema.safeParse(
          await ctx.request.json().catch(() => undefined),
        );
        if (!parsed.success) {
          return fail(400, 'validation_failed', 'Request body is invalid.', parsed.error.issues);
        }
        return HttpResponse.json(checkpoints.act(projectId, checkpointId(ctx), parsed.data));
      }),
    ),
  ];
}
