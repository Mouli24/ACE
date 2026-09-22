import {
  CreateProjectRequestSchema,
  CreateWorkflowRequestSchema,
  CursorQuerySchema,
  FORMAT_VERSION,
  GraphOpsRequestSchema,
  SettingsPatchSchema,
  UpdateProjectRequestSchema,
  UpdateWorkflowRequestSchema,
  WorkflowExportSchema,
  aceError,
  type ApiError,
  type ErrorKind,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';

import { type MockDb, isUnwritablePath } from './db';
import { applyOpsWithRules, cloneGraph, validateGraph } from './graph-rules';

/**
 * MSW handlers for every round 1 §2.8 endpoint (round 1 §5 step 10). Matched on any origin so the
 * same handlers serve the browser worker (dev, Playwright) and the node server (component tests).
 */

const API = '*/api/v1';

type Ctx = { request: Request; params: PathParams };

const param = (ctx: Ctx, name: string): string => String(ctx.params[name] ?? '');

function error(status: number, kind: ErrorKind, code: string, message: string, details?: unknown) {
  const body: ApiError = aceError(kind, code, message, { details, retryable: false });
  return HttpResponse.json(body, { status });
}

const notFound = (what: string) => error(404, 'workflow', 'not_found', `${what} not found.`);

const unauthorized = () => error(401, 'auth', 'unauthorized', 'Missing or invalid session token.');

function validationFailed(details: unknown, message = 'Request body is invalid.') {
  return error(400, 'invalid_config', 'validation_failed', message, details);
}

/** Cursor pagination: the cursor is the offset into the list, as the mock has no stable order key. */
function page<T>(items: T[], url: URL) {
  const query = CursorQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  const limit = query.success ? query.data.limit : 50;
  const offset = query.success && query.data.cursor ? Number(query.data.cursor) || 0 : 0;
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  return HttpResponse.json({
    items: slice,
    ...(nextOffset < items.length ? { nextCursor: String(nextOffset) } : {}),
  });
}

async function body<T>(
  request: Request,
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false as const, response: validationFailed('Body is not JSON.') };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return { ok: false as const, response: validationFailed(parsed.error.issues) };
  return { ok: true as const, data: parsed.data };
}

function hasToken(request: Request): boolean {
  const header = request.headers.get('authorization') ?? '';
  return /^Bearer\s+\S+$/.test(header);
}

export function createHandlers(db: MockDb): HttpHandler[] {
  /** Every handler re-reads the shared snapshot first, so a second tab sees the first tab's writes. */
  const guard =
    (handler: (ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return unauthorized();
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      return handler(ctx);
    };

  return [
    /* ---------------------------------------------------------------- system */
    http.get(`${API}/health`, () => HttpResponse.json({ status: 'ok', version: 'mock', db: 'ok' })),

    http.get(
      `${API}/settings`,
      guard(() => HttpResponse.json(db.settings)),
    ),

    http.patch(
      `${API}/settings`,
      guard(async ({ request }) => {
        const parsed = await body(request, SettingsPatchSchema);
        if (!parsed.ok) return parsed.response;
        return HttpResponse.json(db.patchSettings(parsed.data));
      }),
    ),

    /* ---------------------------------------------------------------- projects */
    http.get(
      `${API}/projects`,
      guard(({ request }) => page(db.listProjects(), new URL(request.url))),
    ),

    http.post(
      `${API}/projects`,
      guard(async ({ request }) => {
        const parsed = await body(request, CreateProjectRequestSchema);
        if (!parsed.ok) return parsed.response;
        const { folderPath } = parsed.data;
        if (folderPath && isUnwritablePath(folderPath)) {
          return error(
            400,
            'invalid_config',
            'invalid_path',
            `Folder "${folderPath}" is not writable.`,
            {
              path: folderPath,
            },
          );
        }
        return HttpResponse.json(db.createProject(parsed.data), { status: 201 });
      }),
    ),

    http.get(
      `${API}/projects/:id`,
      guard((ctx) => {
        const project = db.getProject(param(ctx, 'id'));
        return project ? HttpResponse.json(project) : notFound('Project');
      }),
    ),

    http.patch(
      `${API}/projects/:id`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, UpdateProjectRequestSchema);
        if (!parsed.ok) return parsed.response;
        const project = db.updateProject(param(ctx, 'id'), parsed.data);
        return project ? HttpResponse.json(project) : notFound('Project');
      }),
    ),

    http.delete(
      `${API}/projects/:id`,
      guard((ctx) =>
        db.deleteProject(param(ctx, 'id'))
          ? new HttpResponse(null, { status: 204 })
          : notFound('Project'),
      ),
    ),

    http.post(
      `${API}/projects/:id/open`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        const project = db.updateProject(id, { lastOpenedAt: new Date().toISOString() });
        if (!project) return notFound('Project');
        db.patchSettings({ lastProjectId: id });
        return HttpResponse.json(project);
      }),
    ),

    /* ---------------------------------------------------------------- workflows */
    http.get(
      `${API}/projects/:id/workflows`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        if (!db.getProject(id)) return notFound('Project');
        return page(db.listWorkflows(id), new URL(ctx.request.url));
      }),
    ),

    http.post(
      `${API}/projects/:id/workflows`,
      guard(async (ctx) => {
        const id = param(ctx, 'id');
        if (!db.getProject(id)) return notFound('Project');
        const parsed = await body(ctx.request, CreateWorkflowRequestSchema);
        if (!parsed.ok) return parsed.response;
        return HttpResponse.json(db.createWorkflow(id, parsed.data.name), { status: 201 });
      }),
    ),

    http.post(
      `${API}/projects/:id/workflows/import`,
      guard(async (ctx) => {
        const projectId = param(ctx, 'id');
        if (!db.getProject(projectId)) return notFound('Project');
        let raw: unknown;
        try {
          raw = await ctx.request.json();
        } catch {
          return validationFailed('Body is not JSON.');
        }
        const version = (raw as { formatVersion?: unknown } | null)?.formatVersion;
        if (version !== FORMAT_VERSION) {
          return error(
            400,
            'invalid_config',
            'unsupported_format_version',
            `Unsupported formatVersion ${String(version)}; this engine reads ${FORMAT_VERSION}.`,
          );
        }
        const parsed = WorkflowExportSchema.safeParse(raw);
        if (!parsed.success) return validationFailed(parsed.error.issues);
        const workflow = db.createWorkflow(projectId, parsed.data.name);
        const cloned = cloneGraph(workflow, parsed.data.nodes, parsed.data.edges);
        const committed = db.commitGraph(workflow.id, cloned.nodes, cloned.edges);
        return HttpResponse.json({ workflow: committed, ...cloned }, { status: 201 });
      }),
    ),

    http.get(
      `${API}/workflows/:id`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        const workflow = db.getWorkflow(id);
        if (!workflow) return notFound('Workflow');
        return HttpResponse.json({ workflow, nodes: db.nodesOf(id), edges: db.edgesOf(id) });
      }),
    ),

    http.patch(
      `${API}/workflows/:id`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, UpdateWorkflowRequestSchema);
        if (!parsed.ok) return parsed.response;
        const workflow = db.updateWorkflow(param(ctx, 'id'), parsed.data);
        return workflow ? HttpResponse.json(workflow) : notFound('Workflow');
      }),
    ),

    http.delete(
      `${API}/workflows/:id`,
      guard((ctx) =>
        db.deleteWorkflow(param(ctx, 'id'))
          ? new HttpResponse(null, { status: 204 })
          : notFound('Workflow'),
      ),
    ),

    http.post(
      `${API}/workflows/:id/duplicate`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        const source = db.getWorkflow(id);
        if (!source) return notFound('Workflow');
        const workflow = db.createWorkflow(source.projectId, `${source.name} (copy)`);
        const cloned = cloneGraph(workflow, db.nodesOf(id), db.edgesOf(id));
        const committed = db.commitGraph(workflow.id, cloned.nodes, cloned.edges);
        return HttpResponse.json({ workflow: committed, ...cloned }, { status: 201 });
      }),
    ),

    http.post(
      `${API}/workflows/:id/graph-ops`,
      guard(async (ctx) => {
        const id = param(ctx, 'id');
        const workflow = db.getWorkflow(id);
        if (!workflow) return notFound('Workflow');
        const parsed = await body(ctx.request, GraphOpsRequestSchema);
        if (!parsed.ok) return parsed.response;
        if (parsed.data.baseVersion !== workflow.version) {
          return error(
            409,
            'workflow',
            'stale_version',
            `Workflow is at version ${workflow.version}, not ${parsed.data.baseVersion}.`,
            { currentVersion: workflow.version },
          );
        }
        const result = applyOpsWithRules(id, db.nodesOf(id), db.edgesOf(id), parsed.data.ops);
        if (!result.ok) {
          return error(result.status, 'workflow', result.code, result.message, result.issues);
        }
        const committed = db.commitGraph(id, result.nodes, result.edges);
        return HttpResponse.json({
          version: committed.version,
          nodes: result.nodes,
          edges: result.edges,
        });
      }),
    ),

    http.post(
      `${API}/workflows/:id/validate`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        if (!db.getWorkflow(id)) return notFound('Workflow');
        return HttpResponse.json({ issues: validateGraph(db.nodesOf(id), db.edgesOf(id)) });
      }),
    ),

    http.get(
      `${API}/workflows/:id/export`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        const workflow = db.getWorkflow(id);
        if (!workflow) return notFound('Workflow');
        return HttpResponse.json({
          formatVersion: FORMAT_VERSION,
          exportedAt: new Date().toISOString(),
          name: workflow.name,
          nodes: db.nodesOf(id),
          edges: db.edgesOf(id),
        });
      }),
    ),
  ];
}
