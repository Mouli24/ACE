import {
  ProcessInputRequestSchema,
  ProcessStartRequestSchema,
  UpdateProjectRequestSchema,
  aceError,
} from '@ace/contracts';
import { http, HttpResponse, type HttpHandler, type PathParams } from 'msw';

import type { MockDb } from './db';
import { MockProcessError, type MockProcesses } from './processes';

/**
 * Forge's terminal routes on the mock engine (D301, design §6.3), over a scripted `MockProcesses`.
 * Listed before every other handler, so it answers a project PATCH and sees a project DELETE first.
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

export function createProcessHandlers(db: MockDb, processes: MockProcesses): HttpHandler[] {
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
        if (error instanceof MockProcessError) {
          return fail(error.status, error.code, error.message, error.details);
        }
        throw error;
      }
    };

  const invalid = (issues: unknown) =>
    fail(400, 'validation_failed', 'Request body is invalid.', issues);

  return [
    // The projects PATCH, answered here as the engine answers it (D301): validate, update, and
    // then, when the patch turns the terminal off, stop what the project runs.
    http.patch(`${API}/projects/:id`, async ({ request, params }) => {
      if (!hasToken(request)) return fail(401, 'unauthorized', 'Missing or invalid session token.');
      db.load();
      const parsed = UpdateProjectRequestSchema.safeParse(
        await request.json().catch(() => undefined),
      );
      if (!parsed.success) return invalid(parsed.error.issues);
      const projectId = String(params.id ?? '');
      const project = db.updateProject(projectId, parsed.data);
      if (project === undefined) return fail(404, 'not_found', 'Project not found.');
      if (parsed.data.terminal === 'off') processes.stopProject(projectId);
      return HttpResponse.json(project);
    }),

    // A project DELETE stops what the project runs first, as the engine does (D301). It answers
    // nothing, so the projects handler that follows still checks the token and deletes.
    http.delete(`${API}/projects/:id`, ({ request, params }) => {
      if (hasToken(request)) processes.stopProject(String(params.id ?? ''));
      return undefined;
    }),

    // Before `/:procId`, which would otherwise read "scripts" as a process id.
    http.get(
      `${API}/projects/:id/processes/scripts`,
      route((projectId) => HttpResponse.json(processes.scripts(projectId))),
    ),

    http.get(
      `${API}/projects/:id/processes`,
      route((projectId) => HttpResponse.json(processes.list(projectId))),
    ),

    http.post(
      `${API}/projects/:id/processes`,
      route(async (projectId, { request }) => {
        const parsed = ProcessStartRequestSchema.safeParse(
          await request.json().catch(() => undefined),
        );
        if (!parsed.success) return invalid(parsed.error.issues);
        return HttpResponse.json(processes.start(projectId, parsed.data), { status: 201 });
      }),
    ),

    http.get(
      `${API}/projects/:id/processes/:procId`,
      route((projectId, { params }) =>
        HttpResponse.json(processes.get(projectId, String(params.procId ?? ''))),
      ),
    ),

    http.post(
      `${API}/projects/:id/processes/:procId/input`,
      route(async (projectId, { request, params }) => {
        const parsed = ProcessInputRequestSchema.safeParse(
          await request.json().catch(() => undefined),
        );
        if (!parsed.success) return invalid(parsed.error.issues);
        processes.input(projectId, String(params.procId ?? ''), parsed.data.data);
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.post(
      `${API}/projects/:id/processes/:procId/stop`,
      route((projectId, { params }) => {
        processes.stop(projectId, String(params.procId ?? ''));
        return new HttpResponse(null, { status: 204 });
      }),
    ),
  ];
}
