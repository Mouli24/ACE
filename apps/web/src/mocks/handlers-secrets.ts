import {
  CreateSecretRequestSchema,
  UpdateSecretRequestSchema,
  aceError,
  type ApiError,
  type ErrorKind,
  type PendingApproval,
  type Secret,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';

import type { MockDb } from './db';
import { deleteMockSecret, getMockSecret, listMockSecrets, putMockSecret } from './secrets';

/**
 * MSW handlers for ACE parity P1's secrets (D274) and the approvals inbox (D270).
 *
 * `/secrets` keeps rows and values apart (`mocks/secrets.ts`): a value is written to the mock
 * keychain and never answered. `GET /approvals` lists every pending approval of every run, oldest
 * first, with the run's workflow and project and — when a task's execution started the run — the
 * task, exactly as the engine's inbox does. Approve and reject stay round 3's handlers.
 */

const API = '*/api/v1';

type Ctx = { request: Request; params: PathParams };
const param = (ctx: Ctx, name: string): string => String(ctx.params[name] ?? '');

function error(status: number, kind: ErrorKind, code: string, message: string, details?: unknown) {
  const body: ApiError = aceError(kind, code, message, { details, retryable: false });
  return HttpResponse.json(body, { status });
}

const unauthorized = () => error(401, 'auth', 'unauthorized', 'Missing or invalid session token.');
const validationFailed = (details: unknown) =>
  error(400, 'invalid_config', 'validation_failed', 'The request body is invalid.', details);
const secretNotFound = (name: string) =>
  error(404, 'workflow', 'not_found', `Secret ${name} was not found.`);

function hasToken(request: Request): boolean {
  return /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');
}

async function json(request: Request): Promise<{ ok: true; raw: unknown } | { ok: false }> {
  try {
    const text = await request.text();
    return { ok: true, raw: text.trim() === '' ? {} : JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** The pending approvals of every run in the mock engine, oldest first (D270). */
export function pendingApprovalsOf(db: MockDb): PendingApproval[] {
  const items: PendingApproval[] = [];
  for (const run of db.allRuns()) {
    const pending = db.pendingApprovals(run.id);
    if (pending.length === 0) continue;
    const task = db
      .listTasks(run.projectId)
      .find((candidate) =>
        db.taskExecutionsOf(candidate.id).some((execution) => execution.runId === run.id),
      );
    for (const request of pending) {
      items.push({
        request,
        workflowId: run.workflowId,
        projectId: run.projectId,
        ...(task === undefined ? {} : { taskId: task.id }),
      });
    }
  }
  return items.sort(
    (a, b) =>
      a.request.requestedAt.localeCompare(b.request.requestedAt) ||
      a.request.id.localeCompare(b.request.id),
  );
}

export function createSecretHandlers(db: MockDb): HttpHandler[] {
  const guard =
    (handler: (ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return unauthorized();
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      return handler(ctx);
    };

  const unknownProject = (projectIds: readonly string[]): string | undefined =>
    projectIds.find((id) => db.getProject(id) === undefined);

  return [
    /* ------------------------------------------------- the approvals inbox (D270) */
    http.get(
      `${API}/approvals`,
      guard(() => HttpResponse.json({ items: pendingApprovalsOf(db) })),
    ),

    /* ------------------------------------------------- secrets (D274) */
    http.get(
      `${API}/secrets`,
      guard(() => HttpResponse.json({ items: listMockSecrets() })),
    ),

    http.post(
      `${API}/secrets`,
      guard(async (ctx) => {
        const body = await json(ctx.request);
        if (!body.ok) return validationFailed('Body is not JSON.');
        const parsed = CreateSecretRequestSchema.safeParse(body.raw);
        if (!parsed.success) return validationFailed(parsed.error.issues);
        const { name, value, description, projectIds } = parsed.data;
        if (getMockSecret(name) !== undefined) {
          return error(
            409,
            'invalid_config',
            'name_taken',
            `A secret named ${name} already exists.`,
            {
              name,
            },
          );
        }
        const scope = [...new Set(projectIds ?? [])];
        const missing = unknownProject(scope);
        if (missing !== undefined) return validationFailed(`Project ${missing} was not found.`);
        const at = new Date().toISOString();
        const secret: Secret = {
          name,
          description: description ?? '',
          projectIds: scope,
          createdAt: at,
          updatedAt: at,
        };
        return HttpResponse.json(putMockSecret(secret, value), { status: 201 });
      }),
    ),

    http.patch(
      `${API}/secrets/:name`,
      guard(async (ctx) => {
        const name = param(ctx, 'name');
        const existing = getMockSecret(name);
        if (existing === undefined) return secretNotFound(name);
        const body = await json(ctx.request);
        if (!body.ok) return validationFailed('Body is not JSON.');
        const parsed = UpdateSecretRequestSchema.safeParse(body.raw);
        if (!parsed.success) return validationFailed(parsed.error.issues);
        const { value, description, projectIds } = parsed.data;
        const scope = projectIds === undefined ? existing.projectIds : [...new Set(projectIds)];
        const missing = unknownProject(scope);
        if (missing !== undefined) return validationFailed(`Project ${missing} was not found.`);
        const secret: Secret = {
          ...existing,
          ...(description === undefined ? {} : { description }),
          projectIds: scope,
          updatedAt: new Date().toISOString(),
        };
        return HttpResponse.json(putMockSecret(secret, value));
      }),
    ),

    http.delete(
      `${API}/secrets/:name`,
      guard((ctx) => {
        const name = param(ctx, 'name');
        if (!deleteMockSecret(name)) return secretNotFound(name);
        return new HttpResponse(null, { status: 204 });
      }),
    ),
  ];
}
