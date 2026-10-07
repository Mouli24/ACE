import {
  AcceptTaskRequestSchema,
  ApplyTaskRequestSchema,
  CloneProjectRequestSchema,
  CloseTaskRequestSchema,
  CreateTaskRequestSchema,
  MergePullRequestRequestSchema,
  OpenPullRequestRequestSchema,
  PauseTaskRequestSchema,
  PutDeliverableRequestSchema,
  PutTaskScheduleRequestSchema,
  ReviewTaskRequestSchema,
  StartWorkRequestSchema,
  TaskListQuerySchema,
  UpdateProjectRequestSchema,
  UpdateTaskRequestSchema,
  aceError,
  needsAttention,
  type ApiError,
  type ErrorKind,
  type Task,
  type TaskListQuery,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';
import { z } from 'zod';

import type { MockDb } from './db';
import {
  TaskEngineError,
  acceptTask,
  applyTask,
  cloneProject,
  closeTask,
  createTask,
  deleteTask,
  initRepository,
  mergePullRequest,
  openPullRequest,
  pauseTask,
  planTask,
  putDeliverable,
  putSchedule,
  readTask,
  removeSchedule,
  repositoryInfo,
  resumeProject,
  retryTask,
  reviewTask,
  runTaskChecks,
  sendTask,
  startPreview,
  startTask,
  stopPreview,
  stopTask,
  taskChanges,
  taskDetail,
  taskFileDiff,
  updateTask,
  workTask,
} from './tasks';

/**
 * MSW handlers for the ACE parity P0 endpoints (design §6): tasks and their actions, changes and
 * one file's diff, the project repository, and the project PATCH with its new Build fields. The
 * state machine itself is `mocks/tasks.ts`; these only parse, call it and answer. Registered ahead
 * of every round's handlers, so this project PATCH (which also resumes a paused project's queue)
 * wins over round 1's. ACE parity P1 adds the deliverable, accept/send, pull request, preview and
 * schedule routes and `POST /projects/clone` (D275–D278).
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
  error(400, 'invalid_config', 'validation_failed', 'Request body is invalid.', details);

function hasToken(request: Request): boolean {
  return /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');
}

/** An empty body reads as `{}`, as the engine's `readJson` does (actions need none). */
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
    const text = await request.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return { ok: false as const, response: validationFailed('Body is not JSON.') };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, response: validationFailed(parsed.error.issues) };
  }
  return { ok: true as const, data: parsed.data };
}

const EmptyBodySchema = z.strictObject({});

/** Run one engine call, answering its refusal as the `ApiError` envelope. */
function answer(run: () => unknown, status = 200): Response {
  try {
    const result = run();
    if (result === undefined) return new HttpResponse(null, { status: 204 });
    return HttpResponse.json(result as Record<string, unknown>, { status });
  } catch (cause) {
    if (cause instanceof TaskEngineError) {
      return error(cause.status, cause.kind, cause.code, cause.message, cause.details);
    }
    throw cause;
  }
}

/** `GET /projects/:id/tasks`: the filters of `TaskListQuery`, newest task first. */
function filterTasks(tasks: Task[], query: TaskListQuery): Task[] {
  const q = query.q?.toLowerCase();
  const label = query.label?.toLowerCase();
  return tasks
    .filter((task) => query.stage === undefined || task.stage === query.stage)
    .filter(
      (task) =>
        q === undefined ||
        `#${task.number}` === q ||
        task.title.toLowerCase().includes(q) ||
        task.brief.toLowerCase().includes(q),
    )
    .filter((task) => label === undefined || task.labels.some((own) => own.toLowerCase() === label))
    .filter((task) => query.attention !== true || needsAttention(task))
    .sort((a, b) => b.number - a.number);
}

export function createTaskHandlers(db: MockDb): HttpHandler[] {
  const guard =
    (handler: (ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return unauthorized();
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      return handler(ctx);
    };

  /** `POST /tasks/:id/<action>` with a body schema, answering the task. */
  const action = <T>(
    path: string,
    schema: Parameters<typeof body<T>>[1],
    run: (id: string, data: T) => unknown,
  ) =>
    http.post(
      `${API}/tasks/:id/${path}`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, schema);
        if (!parsed.ok) return parsed.response;
        return answer(() => run(param(ctx, 'id'), parsed.data));
      }),
    );

  return [
    /* ------------------------------------------------- projects (Build settings, design §8) */
    http.patch(
      `${API}/projects/:id`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, UpdateProjectRequestSchema);
        if (!parsed.ok) return parsed.response;
        const id = param(ctx, 'id');
        const wasPaused = db.getProject(id)?.paused === true;
        const project = db.updateProject(id, parsed.data);
        if (project === undefined) return error(404, 'workflow', 'not_found', 'Project not found.');
        if (wasPaused && project.paused === false) resumeProject(db, id);
        return HttpResponse.json(db.getProject(id));
      }),
    ),

    http.get(
      `${API}/projects/:id/repository`,
      guard((ctx) => answer(() => repositoryInfo(db, param(ctx, 'id')))),
    ),

    http.post(
      `${API}/projects/:id/repository/init`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, EmptyBodySchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => initRepository(db, param(ctx, 'id')));
      }),
    ),

    /* ------------------------------------------------- tasks */
    http.get(
      `${API}/projects/:id/tasks`,
      guard((ctx) => {
        const projectId = param(ctx, 'id');
        if (db.getProject(projectId) === undefined) {
          return error(404, 'workflow', 'not_found', 'Project not found.');
        }
        const url = new URL(ctx.request.url);
        const query = TaskListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) return validationFailed(query.error.issues);
        const items = filterTasks(db.listTasks(projectId), query.data).map((task) =>
          readTask(db, task),
        );
        return HttpResponse.json({ items });
      }),
    ),

    http.post(
      `${API}/projects/:id/tasks`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, CreateTaskRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => createTask(db, param(ctx, 'id'), parsed.data), 201);
      }),
    ),

    http.get(
      `${API}/tasks/:id`,
      guard((ctx) => answer(() => taskDetail(db, param(ctx, 'id')))),
    ),

    http.patch(
      `${API}/tasks/:id`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, UpdateTaskRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => updateTask(db, param(ctx, 'id'), parsed.data));
      }),
    ),

    http.delete(
      `${API}/tasks/:id`,
      guard((ctx) => answer(() => deleteTask(db, param(ctx, 'id')))),
    ),

    http.get(
      `${API}/tasks/:id/activity`,
      guard((ctx) =>
        answer(() => {
          const id = param(ctx, 'id');
          taskDetail(db, id);
          return { items: db.taskActivityOf(id) };
        }),
      ),
    ),

    http.get(
      `${API}/tasks/:id/changes`,
      guard((ctx) => answer(() => taskChanges(db, param(ctx, 'id')))),
    ),

    http.get(
      `${API}/tasks/:id/changes/diff`,
      guard((ctx) => {
        const path = new URL(ctx.request.url).searchParams.get('path');
        if (path === null || path === '') {
          return validationFailed([{ path: ['path'], message: 'Name the file.' }]);
        }
        return answer(() => taskFileDiff(db, param(ctx, 'id'), path));
      }),
    ),

    /* ------------------------------------------------- task actions (design §2) */
    action('start', EmptyBodySchema, (id) => startTask(db, id)),
    action('plan', EmptyBodySchema, (id) => planTask(db, id)),
    action('stop', EmptyBodySchema, (id) => stopTask(db, id)),
    action('retry', EmptyBodySchema, (id) => retryTask(db, id)),
    action('checks', EmptyBodySchema, (id) => runTaskChecks(db, id)),
    action('work', StartWorkRequestSchema, (id, data) => workTask(db, id, data.message)),
    action('review', ReviewTaskRequestSchema, (id, data) => reviewTask(db, id, data)),
    action('apply', ApplyTaskRequestSchema, (id, data) => applyTask(db, id, data)),
    action('close', CloseTaskRequestSchema, (id, data) => closeTask(db, id, data.reason)),
    action('pause', PauseTaskRequestSchema, (id, data) => pauseTask(db, id, data.paused)),

    /* ------------------------------------------------- ACE parity P1 (D275–D278) */
    http.put(
      `${API}/tasks/:id/deliverable`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, PutDeliverableRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => putDeliverable(db, param(ctx, 'id'), parsed.data.deliverable));
      }),
    ),
    action('accept', AcceptTaskRequestSchema, (id, data) => acceptTask(db, id, data)),
    action('send', EmptyBodySchema, (id) => sendTask(db, id)),
    action('open-pr', OpenPullRequestRequestSchema, (id, data) => openPullRequest(db, id, data)),
    action('merge-pr', MergePullRequestRequestSchema, (id, data) => mergePullRequest(db, id, data)),
    action('preview/start', EmptyBodySchema, (id) => startPreview(db, id)),
    action('preview/stop', EmptyBodySchema, (id) => stopPreview(db, id)),

    http.put(
      `${API}/tasks/:id/schedule`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, PutTaskScheduleRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => putSchedule(db, param(ctx, 'id'), parsed.data));
      }),
    ),
    http.delete(
      `${API}/tasks/:id/schedule`,
      guard((ctx) => answer(() => removeSchedule(db, param(ctx, 'id')))),
    ),

    http.post(
      `${API}/projects/clone`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, CloneProjectRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => cloneProject(db, parsed.data), 201);
      }),
    ),
  ];
}
