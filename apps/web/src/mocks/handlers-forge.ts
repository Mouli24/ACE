import {
  CreateEntryRequestSchema,
  ERROR_CODE_HTTP_STATUS,
  MoveEntryRequestSchema,
  SaveFileRequestSchema,
  aceError,
  type FileChange,
} from '@ace/contracts';
import { http, HttpResponse, type HttpHandler, type PathParams } from 'msw';

import type { MockDb } from './db';
import * as files from './files';
import { MockFsError, type MockFs } from './files';

/**
 * Forge's file routes on the mock engine (D299, design §6.1), so the web app and its tests run
 * with zero env vars. Every change is announced on the project's scope, as the engine's watcher
 * would announce the same change on disk — including the app's own saves.
 */

const API = '*/api/v1';

type Ctx = { request: Request; params: PathParams };
type Handle = (
  fs: MockFs,
  projectId: string,
  request: Request,
  url: URL,
) => Response | Promise<Response>;

const hasToken = (request: Request): boolean =>
  /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');

const fail = (
  status: number,
  kind: 'auth' | 'workflow' | 'invalid_config',
  code: string,
  message: string,
  details?: unknown,
) => HttpResponse.json(aceError(kind, code, message, { details, retryable: false }), { status });

function refusal(error: unknown): Response {
  if (!(error instanceof MockFsError)) throw error;
  const state =
    error.code === 'file_changed' || error.code === 'exists' || error.code === 'not_found';
  return fail(
    ERROR_CODE_HTTP_STATUS[error.code],
    state ? 'workflow' : 'invalid_config',
    error.code,
    error.message,
    error.details,
  );
}

function requiredPath(url: URL): string {
  const path = url.searchParams.get('path') ?? '';
  if (path === '') throw new MockFsError('invalid_path', 'A path is required.');
  return path;
}

async function parsed<T>(
  request: Request,
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
) {
  const result = schema.safeParse(await request.json().catch(() => undefined));
  if (!result.success) {
    return {
      ok: false as const,
      response: fail(
        400,
        'invalid_config',
        'validation_failed',
        'Request body is invalid.',
        result.error.issues,
      ),
    };
  }
  return { ok: true as const, data: result.data };
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export function createForgeHandlers(db: MockDb): HttpHandler[] {
  const route =
    (handle: Handle) =>
    async ({ request, params }: Ctx): Promise<Response> => {
      if (!hasToken(request))
        return fail(401, 'auth', 'unauthorized', 'Missing or invalid session token.');
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      const projectId = String(params.id ?? '');
      if (db.getProject(projectId) === undefined)
        return fail(404, 'workflow', 'not_found', 'Project not found.');
      try {
        return await handle(db.filesOf(projectId), projectId, request, new URL(request.url));
      } catch (error) {
        return refusal(error);
      }
    };

  const announce = (projectId: string, changes: FileChange[]): void => {
    db.save();
    db.emitFilesChanged(projectId, changes);
  };

  return [
    http.get(
      `${API}/projects/:id/files/tree`,
      route((fs, _id, _request, url) =>
        HttpResponse.json(files.listFolder(fs, url.searchParams.get('path') ?? '')),
      ),
    ),

    http.get(
      `${API}/projects/:id/files/content`,
      route((fs, _id, _request, url) => HttpResponse.json(files.readFile(fs, requiredPath(url)))),
    ),

    http.get(
      `${API}/projects/:id/files/raw`,
      route((fs, _id, _request, url) => {
        const path = requiredPath(url);
        const entry = fs[path];
        if (entry?.kind !== 'file') throw new MockFsError('not_found', `${path} was not found.`);
        const type =
          IMAGE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ??
          'application/octet-stream';
        return new HttpResponse(entry.content, { headers: { 'content-type': type } });
      }),
    ),

    http.put(
      `${API}/projects/:id/files/content`,
      route(async (fs, projectId, request) => {
        const body = await parsed(request, SaveFileRequestSchema);
        if (!body.ok) return body.response;
        const existed = fs[body.data.path] !== undefined;
        const result = files.writeFile(fs, body.data);
        announce(projectId, [{ path: result.path, kind: existed ? 'changed' : 'created' }]);
        return HttpResponse.json(result);
      }),
    ),

    http.post(
      `${API}/projects/:id/files/entries`,
      route(async (fs, projectId, request) => {
        const body = await parsed(request, CreateEntryRequestSchema);
        if (!body.ok) return body.response;
        const entry = files.createEntry(fs, body.data);
        announce(projectId, [{ path: entry.path, kind: 'created' }]);
        return HttpResponse.json(entry, { status: 201 });
      }),
    ),

    http.post(
      `${API}/projects/:id/files/move`,
      route(async (fs, projectId, request) => {
        const body = await parsed(request, MoveEntryRequestSchema);
        if (!body.ok) return body.response;
        const entry = files.moveEntry(fs, body.data.from, body.data.to);
        announce(projectId, [
          { path: body.data.from, kind: 'deleted' },
          { path: entry.path, kind: 'created' },
        ]);
        return HttpResponse.json(entry);
      }),
    ),

    http.delete(
      `${API}/projects/:id/files/entries`,
      route((fs, projectId, _request, url) => {
        const path = requiredPath(url);
        files.removeEntry(fs, path);
        announce(projectId, [{ path, kind: 'deleted' }]);
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.get(
      `${API}/projects/:id/files/list`,
      route((fs) => HttpResponse.json(files.listAll(fs))),
    ),

    http.get(
      `${API}/projects/:id/files/status`,
      route((_fs, projectId) => HttpResponse.json(db.repoStatusOf(projectId))),
    ),
  ];
}
