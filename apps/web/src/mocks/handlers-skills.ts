import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  BundleFileSchema,
  CreateSkillRequestSchema,
  UpdateSkillRequestSchema,
  aceError,
  type ApiError,
  type ErrorKind,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';
import { z } from 'zod';

import type { MockDb } from './db';
import {
  SkillEngineError,
  createSkill,
  deleteBundle,
  deleteSkill,
  duplicateSkill,
  getSkill,
  importBundle,
  listBundles,
  listSkills,
  updateSkill,
} from './skills';

/**
 * MSW handlers for the ACE parity P1 skills and bundles endpoints (D272, D273). The rules are
 * `mocks/skills.ts`; these only parse, call it and answer, as the task handlers do.
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

/** The body as JSON (empty reads as `{}`, as the engine's `readJson` does), or the refusal. */
async function readBody(
  request: Request,
): Promise<{ ok: true; raw: unknown } | { ok: false; response: Response }> {
  try {
    const text = await request.text();
    return { ok: true, raw: text.trim() === '' ? {} : JSON.parse(text) };
  } catch {
    return { ok: false, response: validationFailed('Body is not JSON.') };
  }
}

async function body<T>(
  request: Request,
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
) {
  const read = await readBody(request);
  if (!read.ok) return read;
  const parsed = schema.safeParse(read.raw);
  if (!parsed.success)
    return { ok: false as const, response: validationFailed(parsed.error.issues) };
  return { ok: true as const, data: parsed.data };
}

/** Run one engine call, answering its refusal as the `ApiError` envelope. */
function answer(run: () => unknown, status = 200): Response {
  try {
    const result = run();
    if (result === undefined) return new HttpResponse(null, { status: 204 });
    return HttpResponse.json(result as Record<string, unknown>, { status });
  } catch (cause) {
    if (cause instanceof SkillEngineError) {
      return error(cause.status, cause.kind, cause.code, cause.message);
    }
    throw cause;
  }
}

const EmptyBodySchema = z.strictObject({});
const BundleHeaderSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  formatVersion: z.unknown(),
});

export function createSkillHandlers(db: MockDb): HttpHandler[] {
  const guard =
    (handler: (ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return unauthorized();
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      return handler(ctx);
    };

  return [
    /* ------------------------------------------------- skills */
    http.get(
      `${API}/skills`,
      guard(() => answer(() => ({ items: listSkills(db) }))),
    ),

    http.post(
      `${API}/skills`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, CreateSkillRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => createSkill(db, parsed.data), 201);
      }),
    ),

    http.get(
      `${API}/skills/:id`,
      guard((ctx) => answer(() => getSkill(db, param(ctx, 'id')))),
    ),

    http.patch(
      `${API}/skills/:id`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, UpdateSkillRequestSchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => updateSkill(db, param(ctx, 'id'), parsed.data));
      }),
    ),

    http.delete(
      `${API}/skills/:id`,
      guard((ctx) => answer(() => deleteSkill(db, param(ctx, 'id')))),
    ),

    http.post(
      `${API}/skills/:id/duplicate`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, EmptyBodySchema);
        if (!parsed.ok) return parsed.response;
        return answer(() => duplicateSkill(db, param(ctx, 'id')), 201);
      }),
    ),

    /* ------------------------------------------------- bundles (D273) */
    http.get(
      `${API}/bundles`,
      guard(() => answer(() => ({ items: listBundles(db) }))),
    ),

    http.post(
      `${API}/bundles/import`,
      guard(async (ctx) => {
        const read = await readBody(ctx.request);
        if (!read.ok) return read.response;
        const header = BundleHeaderSchema.safeParse(read.raw);
        if (header.success && header.data.formatVersion !== BUNDLE_FORMAT_VERSION) {
          return error(
            400,
            'invalid_config',
            'unsupported_format_version',
            `This file is format version ${String(header.data.formatVersion)}; this engine reads version ${BUNDLE_FORMAT_VERSION}.`,
          );
        }
        const parsed = BundleFileSchema.safeParse(read.raw);
        if (!parsed.success) return validationFailed(parsed.error.issues);
        return answer(() => importBundle(db, parsed.data), 201);
      }),
    ),

    http.delete(
      `${API}/bundles/:id`,
      guard((ctx) => answer(() => deleteBundle(db, param(ctx, 'id')))),
    ),
  ];
}
