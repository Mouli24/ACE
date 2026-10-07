import {
  AcceptSuggestionRequestSchema,
  AssistantApplyRequestSchema,
  AssistantProposeRequestSchema,
  CreateProjectNoteRequestSchema,
  CreateResponsibilityRequestSchema,
  ImportEmailRequestSchema,
  SuggestionListQuerySchema,
  UpdateProjectNoteRequestSchema,
  UpdateResponsibilityRequestSchema,
  aceError,
  type ApiError,
  type ErrorKind,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';

import { applySetup, proposeSetup } from './assistant';
import type { MockDb } from './db';
import {
  SuggestionEngineError,
  acceptSuggestion,
  cancelResponsibilityScan,
  createNote,
  createResponsibility,
  deleteNote,
  deleteResponsibility,
  dismissSuggestion,
  importEmail,
  laterSuggestion,
  listNotes,
  listResponsibilities,
  listSuggestions,
  scanResponsibility,
  suggestionStore,
  updateNote,
  updateResponsibility,
  type SuggestionStoreOptions,
} from './suggestions';
import { TaskEngineError } from './tasks';

/**
 * MSW handlers for the ACE parity P2 endpoints (D280–D283): responsibilities and their scans,
 * suggestions, team notes, the email import and the Ace Assistant. The rules are
 * `mocks/suggestions.ts` and `mocks/assistant.ts`; these only parse, call them and answer, as the
 * task and skill handlers do. Bodies the engine does not read (scan, later, dismiss) are not read.
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

/** An empty body reads as `{}`, as the engine's `readJson` does. */
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

/** Run one engine call, answering its refusal (or the task store's) as the `ApiError` envelope. */
function answer(run: () => unknown, status = 200): Response {
  try {
    const result = run();
    if (result === undefined) return new HttpResponse(null, { status: 204 });
    return HttpResponse.json(result as Record<string, unknown>, { status });
  } catch (cause) {
    if (cause instanceof SuggestionEngineError || cause instanceof TaskEngineError) {
      return error(cause.status, cause.kind, cause.code, cause.message);
    }
    throw cause;
  }
}

export function createSuggestionHandlers(
  db: MockDb,
  options: SuggestionStoreOptions = {},
): HttpHandler[] {
  const store = suggestionStore(db, options);
  const guard =
    (handler: (ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return unauthorized();
      db.load();
      store.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      return handler(ctx);
    };

  return [
    /* ------------------------------------------------- responsibilities (D280) */
    http.get(
      `${API}/projects/:id/responsibilities`,
      guard((ctx) => answer(() => ({ items: listResponsibilities(db, param(ctx, 'id')) }))),
    ),

    http.post(
      `${API}/projects/:id/responsibilities`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, CreateResponsibilityRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => createResponsibility(db, param(ctx, 'id'), parsed.data), 201);
      }),
    ),

    http.patch(
      `${API}/responsibilities/:id`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, UpdateResponsibilityRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => updateResponsibility(db, param(ctx, 'id'), parsed.data));
      }),
    ),

    http.delete(
      `${API}/responsibilities/:id`,
      guard((ctx) => answer(() => deleteResponsibility(db, param(ctx, 'id')))),
    ),

    http.post(
      `${API}/responsibilities/:id/scan`,
      guard((ctx) => answer(() => scanResponsibility(db, param(ctx, 'id')))),
    ),

    http.post(
      `${API}/responsibilities/:id/cancel-scan`,
      guard((ctx) => answer(() => cancelResponsibilityScan(db, param(ctx, 'id')))),
    ),

    /* ------------------------------------------------- suggestions (D280) */
    http.get(
      `${API}/projects/:id/suggestions`,
      guard((ctx) => {
        const url = new URL(ctx.request.url);
        const query = SuggestionListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) return validationFailed(query.error.issues);
        return answer(() => ({
          items: listSuggestions(db, param(ctx, 'id'), query.data.status),
        }));
      }),
    ),

    http.post(
      `${API}/suggestions/:id/accept`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, AcceptSuggestionRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => acceptSuggestion(db, param(ctx, 'id'), parsed.data));
      }),
    ),

    http.post(
      `${API}/suggestions/:id/later`,
      guard((ctx) => answer(() => laterSuggestion(db, param(ctx, 'id')))),
    ),

    http.post(
      `${API}/suggestions/:id/dismiss`,
      guard((ctx) => answer(() => dismissSuggestion(db, param(ctx, 'id')))),
    ),

    /* ------------------------------------------------- team notes (D281) */
    http.get(
      `${API}/projects/:id/notes`,
      guard((ctx) => answer(() => ({ items: listNotes(db, param(ctx, 'id')) }))),
    ),

    http.post(
      `${API}/projects/:id/notes`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, CreateProjectNoteRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => createNote(db, param(ctx, 'id'), parsed.data), 201);
      }),
    ),

    http.patch(
      `${API}/notes/:id`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, UpdateProjectNoteRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => updateNote(db, param(ctx, 'id'), parsed.data));
      }),
    ),

    http.delete(
      `${API}/notes/:id`,
      guard((ctx) => answer(() => deleteNote(db, param(ctx, 'id')))),
    ),

    /* ------------------------------------------------- email import (D282) */
    http.post(
      `${API}/projects/:id/tasks/import-email`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, ImportEmailRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => importEmail(db, param(ctx, 'id'), parsed.data), 201);
      }),
    ),

    /* ------------------------------------------------- the Ace Assistant (D283) */
    http.post(
      `${API}/assistant/propose`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, AssistantProposeRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => proposeSetup(db, parsed.data));
      }),
    ),

    http.post(
      `${API}/assistant/apply`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, AssistantApplyRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => applySetup(db, parsed.data), 201);
      }),
    ),
  ];
}
