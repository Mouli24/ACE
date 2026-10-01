import {
  AddKbDocumentRequestSchema,
  BACKUP_CONTENT_TYPE,
  BACKUP_UPLOAD_FIELD,
  CreateKnowledgeBaseRequestSchema,
  InstantiateTemplateRequestSchema,
  SearchRequestSchema,
  UpdateKnowledgeBaseRequestSchema,
  UsageQuerySchema,
  aceError,
  type ApiError,
  type BackupImportResponse,
  type ErrorKind,
  type KnowledgeBase,
  type MemoryOp,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';

import { newId } from '../lib/ulid';
import { type MockBackup, type MockDb } from './db';
import { boundaryOf, parseMultipartFile } from './handlers-round4';
import {
  addDocument,
  cancelIngestion,
  refreshKbCounts,
  searchKnowledgeBase,
  startIngestion,
} from './knowledge';
import { buildHealth, buildTrace, buildUsage } from './observability';
import { TEMPLATES, instantiateTemplate } from './templates';
import { readZip, writeZip } from './zip';

/**
 * MSW handlers for the round 5 endpoints (§2.9): knowledge bases and their documents (with a staged
 * ingestion that streams `kb.ingest`), hybrid search, agent memory, the run trace, usage, health
 * metrics, templates and backup/restore. Registered ahead of every earlier round's handlers.
 *
 * Shapes follow D235: `{ items }` for knowledge bases and documents; a bare array for
 * `MemoryEntry[]`, `TraceEntry[]` and `Template[]`; a 202 `KbDocument` for an added document.
 * `PATCH /settings` needs nothing new here: round 1's handler parses `SettingsPatchSchema`, which
 * already takes `onboardingCompleted` and refuses `telemetryEnabled: true` (D235).
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
const validationFailed = (details: unknown) =>
  error(400, 'invalid_config', 'validation_failed', 'Request body is invalid.', details);

function hasToken(request: Request): boolean {
  return /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');
}

async function body<T>(
  request: Request,
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
  empty: unknown = undefined,
) {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text === '' ? empty : JSON.parse(text);
  } catch {
    return { ok: false as const, response: validationFailed('Body is not JSON.') };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, response: validationFailed(parsed.error.issues) };
  }
  return { ok: true as const, data: parsed.data };
}

const noContent = () => new HttpResponse(null, { status: 204 });

/** The file name a backup downloads as. */
export const BACKUP_ENTRY_NAME = 'ace-backup.json';

/** A backup's zip: one JSON entry holding every table but the keychain (FR-SYS-012, BR-07). */
export function backupZip(db: MockDb): Uint8Array {
  const json = JSON.stringify({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    data: db.exportBackup(),
  });
  return writeZip([{ name: BACKUP_ENTRY_NAME, data: new TextEncoder().encode(json) }]);
}

/** The tables inside a backup zip, or `undefined` when these bytes are not one. */
export function readBackup(bytes: Uint8Array): MockBackup | undefined {
  const entry = readZip(bytes)?.get(BACKUP_ENTRY_NAME);
  if (entry === undefined) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(entry)) as { data?: MockBackup };
    const data = parsed.data;
    if (data === undefined || !Array.isArray(data.projects) || !Array.isArray(data.runs)) {
      return undefined;
    }
    return data;
  } catch {
    return undefined;
  }
}

export function createRound5Handlers(db: MockDb): HttpHandler[] {
  const guard =
    (handler: (ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return unauthorized();
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      return handler(ctx);
    };

  return [
    /* ------------------------------------------------- knowledge bases (§2.1, FR-RAG-001) */
    http.get(
      `${API}/projects/:id/knowledge-bases`,
      guard((ctx) => {
        const projectId = param(ctx, 'id');
        if (db.getProject(projectId) === undefined) return notFound('Project');
        return HttpResponse.json({ items: db.listKnowledgeBases(projectId) });
      }),
    ),

    http.post(
      `${API}/projects/:id/knowledge-bases`,
      guard(async (ctx) => {
        const projectId = param(ctx, 'id');
        if (db.getProject(projectId) === undefined) return notFound('Project');
        const parsed = await body(ctx.request, CreateKnowledgeBaseRequestSchema);
        if (!parsed.ok) return parsed.response;
        const { embeddingProviderId, embeddingModelId } = parsed.data;
        if (db.getProvider(embeddingProviderId) === undefined) {
          return error(
            400,
            'invalid_config',
            'provider_missing',
            'The embedding provider does not exist.',
          );
        }
        const known = db
          .listModels()
          .some((m) => m.providerId === embeddingProviderId && m.modelId === embeddingModelId);
        if (!known) {
          return error(
            400,
            'invalid_config',
            'unavailable_model',
            `"${embeddingModelId}" is not in the catalogue.`,
          );
        }
        const ts = new Date().toISOString();
        const kb: KnowledgeBase = {
          id: newId(),
          projectId,
          ...parsed.data,
          documentCount: 0,
          chunkCount: 0,
          createdAt: ts,
          updatedAt: ts,
        };
        return HttpResponse.json(db.addKnowledgeBase(kb), { status: 201 });
      }),
    ),

    http.get(
      `${API}/knowledge-bases/:id`,
      guard((ctx) => {
        const kb = db.getKnowledgeBase(param(ctx, 'id'));
        return kb ? HttpResponse.json(kb) : notFound('Knowledge base');
      }),
    ),

    http.patch(
      `${API}/knowledge-bases/:id`,
      guard(async (ctx) => {
        const kb = db.getKnowledgeBase(param(ctx, 'id'));
        if (kb === undefined) return notFound('Knowledge base');
        const parsed = await body(ctx.request, UpdateKnowledgeBaseRequestSchema);
        if (!parsed.ok) return parsed.response;
        // a patch naming one of the two is checked against the stored other (D235)
        const size = parsed.data.chunkSize ?? kb.chunkSize;
        const overlap = parsed.data.chunkOverlap ?? kb.chunkOverlap;
        if (overlap >= size) {
          return validationFailed([
            {
              path: ['chunkOverlap'],
              message: 'chunk overlap must be smaller than the chunk size',
            },
          ]);
        }
        return HttpResponse.json(db.updateKnowledgeBase(kb.id, parsed.data));
      }),
    ),

    http.delete(
      `${API}/knowledge-bases/:id`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        if (db.getKnowledgeBase(id) === undefined) return notFound('Knowledge base');
        for (const doc of db.kbDocumentsOf(id)) cancelIngestion(doc.id);
        db.deleteKnowledgeBase(id);
        return noContent();
      }),
    ),

    /* ------------------------------------------------- documents (§2.1, FR-RAG-002/003/009) */
    http.post(
      `${API}/knowledge-bases/:id/documents`,
      guard(async (ctx) => {
        const kb = db.getKnowledgeBase(param(ctx, 'id'));
        if (kb === undefined) return notFound('Knowledge base');
        const parsed = await body(ctx.request, AddKbDocumentRequestSchema);
        if (!parsed.ok) return parsed.response;
        const artifact = db.getArtifact(parsed.data.artifactId);
        if (artifact === undefined) return notFound('Artifact');
        const doc = addDocument(db, kb.id, artifact);
        startIngestion(db, doc.id);
        return HttpResponse.json(doc, { status: 202 });
      }),
    ),

    http.get(
      `${API}/knowledge-bases/:id/documents`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        if (db.getKnowledgeBase(id) === undefined) return notFound('Knowledge base');
        return HttpResponse.json({ items: db.kbDocumentsOf(id) });
      }),
    ),

    http.delete(
      `${API}/kb-documents/:id`,
      guard((ctx) => {
        const doc = db.getKbDocument(param(ctx, 'id'));
        if (doc === undefined) return notFound('Document');
        cancelIngestion(doc.id);
        db.deleteKbDocument(doc.id);
        refreshKbCounts(db, doc.knowledgeBaseId);
        return noContent();
      }),
    ),

    http.post(
      `${API}/knowledge-bases/:id/reindex`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        if (db.getKnowledgeBase(id) === undefined) return notFound('Knowledge base');
        // every document goes through the pipeline again with the base's current chunk settings
        for (const doc of db.kbDocumentsOf(id)) {
          cancelIngestion(doc.id);
          db.updateKbDocument(doc.id, { status: 'pending' });
          startIngestion(db, doc.id);
        }
        return new HttpResponse(null, { status: 202 });
      }),
    ),

    /* ------------------------------------------------- search (§2.1, FR-RAG-004/008) */
    http.post(
      `${API}/knowledge-bases/:id/query`,
      guard(async (ctx) => {
        const id = param(ctx, 'id');
        if (db.getKnowledgeBase(id) === undefined) return notFound('Knowledge base');
        const parsed = await body(ctx.request, SearchRequestSchema);
        if (!parsed.ok) return parsed.response;
        return HttpResponse.json(searchKnowledgeBase(db, id, parsed.data));
      }),
    ),

    /* ------------------------------------------------- memory (§2.2, FR-MEM-001..004) */
    http.get(
      `${API}/nodes/:id/memory`,
      guard((ctx) => {
        const nodeId = param(ctx, 'id');
        const entries = db.memoryOf(nodeId);
        if (entries.length === 0 && db.findNode(nodeId) === undefined) return notFound('Node');
        return HttpResponse.json(entries);
      }),
    ),

    http.delete(
      `${API}/nodes/:id/memory/:entryId`,
      guard((ctx) => {
        const nodeId = param(ctx, 'id');
        const removed = db.deleteMemory(nodeId, { id: param(ctx, 'entryId') });
        if (removed === undefined) return notFound('Memory entry');
        db.emit({
          type: 'memory.updated',
          scope: 'engine',
          payload: { nodeId, ops: [{ op: 'delete', key: removed.key }] },
        });
        return noContent();
      }),
    ),

    http.delete(
      `${API}/nodes/:id/memory`,
      guard((ctx) => {
        const nodeId = param(ctx, 'id');
        const entries = db.memoryOf(nodeId);
        if (entries.length === 0 && db.findNode(nodeId) === undefined) return notFound('Node');
        // a clear is one `delete` op per key (D230); clearing nothing announces nothing
        const ops: MemoryOp[] = entries.map((entry) => ({ op: 'delete', key: entry.key }));
        for (const entry of entries) db.deleteMemory(nodeId, { id: entry.id });
        if (ops.length > 0) {
          db.emit({ type: 'memory.updated', scope: 'engine', payload: { nodeId, ops } });
        }
        return noContent();
      }),
    ),

    /* ------------------------------------------------- trace, usage, health (§2.6) */
    http.get(
      `${API}/runs/:id/trace`,
      guard((ctx) => {
        const run = db.getRun(param(ctx, 'id'));
        return run ? HttpResponse.json(buildTrace(db, run)) : notFound('Run');
      }),
    ),

    http.get(
      `${API}/usage`,
      guard(({ request }) => {
        const params = new URL(request.url).searchParams;
        const groupBy = params.getAll('groupBy');
        const query = UsageQuerySchema.safeParse({
          ...(params.get('from') === null ? {} : { from: params.get('from') }),
          ...(params.get('to') === null ? {} : { to: params.get('to') }),
          // a repeated parameter is a list; a single one reads as a list of one (D234)
          groupBy: groupBy.length === 1 ? groupBy[0] : groupBy,
        });
        if (!query.success) return validationFailed(query.error.issues);
        return HttpResponse.json(buildUsage(db, query.data));
      }),
    ),

    http.get(
      `${API}/metrics/health`,
      guard(() => HttpResponse.json(buildHealth(db))),
    ),

    /* ------------------------------------------------- templates (§2.7, FR-ONB-002) */
    http.get(
      `${API}/templates`,
      guard(() => HttpResponse.json(TEMPLATES)),
    ),

    http.post(
      `${API}/templates/:id/instantiate`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, InstantiateTemplateRequestSchema, {});
        if (!parsed.ok) return parsed.response;
        const outcome = instantiateTemplate(db, param(ctx, 'id'), parsed.data);
        if (!outcome.ok) return notFound(outcome.what);
        return HttpResponse.json(outcome.response, { status: 201 });
      }),
    ),

    /* ------------------------------------------------- backup (§2.7, FR-SYS-012) */
    http.post(
      `${API}/backup/export`,
      guard(() => {
        const zip = backupZip(db);
        const day = new Date().toISOString().slice(0, 10);
        return new HttpResponse(zip, {
          status: 200,
          headers: {
            'Content-Type': BACKUP_CONTENT_TYPE,
            'Content-Disposition': `attachment; filename="ace-backup-${day}.zip"`,
            'Content-Length': String(zip.length),
          },
        });
      }),
    ),

    http.post(
      `${API}/backup/import`,
      guard(async ({ request }) => {
        const boundary = boundaryOf(request.headers.get('content-type'));
        if (boundary === undefined) return validationFailed('Expected a multipart upload.');
        const part = parseMultipartFile(new Uint8Array(await request.arrayBuffer()), boundary);
        if (part === undefined) {
          return validationFailed(`Missing the "${BACKUP_UPLOAD_FIELD}" file field.`);
        }
        const backup = readBackup(part.data);
        if (backup === undefined) {
          return error(400, 'invalid_config', 'invalid_backup', 'That file is not an ACE backup.');
        }
        db.importBackup(backup);
        const restored: BackupImportResponse = {
          restored: {
            projects: backup.projects.length,
            runs: backup.runs.length,
            artifacts: backup.artifacts.length,
          },
        };
        return HttpResponse.json(restored);
      }),
    ),
  ];
}
