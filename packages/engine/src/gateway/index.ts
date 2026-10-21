import {
  API_BASE_PATH,
  ARTIFACT_ACCEPT_RANGES,
  ARTIFACT_UPLOAD_FIELD,
  ApprovalDecisionRequestSchema,
  ChatEditRequestSchema,
  ChatRetryRequestSchema,
  ChatRequestSchema,
  CreateProjectRequestSchema,
  CreateProviderRequestSchema,
  CreateMcpServerRequestSchema,
  CreateWorkflowRequestSchema,
  CursorQuerySchema,
  EventsQuerySchema,
  HealthResponseSchema,
  MessageQuerySchema,
  LocalModelRequestSchema,
  ModelQuerySchema,
  PostMessageRequestSchema,
  PullModelRequestSchema,
  RunExportQuerySchema,
  SettingsPatchSchema,
  StartRunRequestSchema,
  TryModelRequestSchema,
  UpdateProjectRequestSchema,
  ModelCapabilitiesPatchSchema,
  UpdateProviderRequestSchema,
  UpdateWorkflowRequestSchema,
  artifactETag,
  cliPatchError,
  type Id,
  type McpServer,
  type MessageQuery,
  type ToolDefinition,
} from '@ace/contracts';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';

import type { ArtifactService } from '../artifacts/index.js';
import { UnsupportedTypeError, UploadTooLargeError } from '../artifacts/index.js';
import type { ChatService } from '../chat/index.js';
import {
  ChatInputBlockedError,
  ChatModelError,
  ChatNodeNotFoundError,
  ChatRunNotAvailableError,
  ChatTargetInvalidError,
  ChatThreadNodeMismatchError,
  ChatThreadNotFoundError,
  ChatApprovalNotFoundError,
  ChatMessageNotFoundError,
  ChatActionInvalidError,
  ChatWorkflowNotFoundError,
  NotAnAgentNodeError,
} from '../chat/index.js';
import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { GraphService } from '../graph/index.js';
import {
  LocalModelRefusedError,
  ProviderActionError,
  ProviderNotFoundError,
  type ProviderService,
} from '../providers/index.js';
import type { Auth, Repository, Scope } from '../ports/index.js';
import { CANNOT_ALWAYS_ALLOW, type ApprovalService } from '../approvals/index.js';
import { cannotAlwaysAllow, createApprovalRoutes } from '../approvals/routes.js';
import { createGuardrailRoutes, type PolicyService } from '../guardrails/index.js';
import {
  buildRunExport,
  createRunControlRoutes,
  estimateWorkflow,
  type RunControls,
  type RunService,
} from '../runs/index.js';
import { utcDay } from '../budgets/index.js';
import { createDomainRoutes } from '../domain/routes.js';
import type { DomainService } from '../domain/service.js';
import type { BackupService } from '../backup/index.js';
import { createBackupRoutes } from '../backup/routes.js';
import { createKnowledgeRoutes } from '../knowledge/routes.js';
import type { SearchService } from '../knowledge/search.js';
import type { KnowledgeService } from '../knowledge/service.js';
import { createMemoryRoutes } from '../memory/routes.js';
import type { MemoryService } from '../memory/service.js';
import { createTemplateRoutes } from '../templates/routes.js';
import { createBenchRoutes } from '../bench/routes.js';
import type { BenchService } from '../bench/service.js';
import type { TemplateService } from '../templates/service.js';
import type { TraceService } from '../trace/index.js';
import type { UsageService } from '../usage/index.js';
import { createUsageRoutes } from '../usage/routes.js';
import { createWorkspaceRoutes } from '../workspace/routes.js';
import type { WorkspaceService } from '../workspace/service.js';
import { createProcessRoutes } from '../processes/routes.js';
import type { ProcessService } from '../processes/service.js';
import { createCheckpointRoutes } from '../checkpoints/routes.js';
import type { CheckpointService } from '../checkpoints/service.js';
import {
  HttpError,
  forbiddenHost,
  forbiddenOrigin,
  notFound,
  notImplemented,
  providerInUse,
  toApiError,
  unauthorized,
} from './errors.js';
import { readJson } from './read-json.js';

/**
 * The tool catalog `GET /tools` reads (round 4 §2.4). It is a narrow view rather than the concrete
 * `ToolRegistry`, because the engine may not import `@ace/tools` (CLAUDE.md §3.4 rule 3): the
 * composition root binds it to `registry.list()`.
 */
export interface ToolCatalog {
  list(): ToolDefinition[];
}

/**
 * The MCP surface the `/mcp-servers` routes drive (round 4 §2.4, FR-TOOL-007). Register/check
 * connect the server through the MCP manager, persist its row and emit `mcp.status`; the engine
 * never touches `@ace/tools` directly, so the composition root supplies this.
 */
export interface McpService {
  list(): Promise<McpServer[]>;
  get(id: Id): Promise<McpServer | null>;
  create(request: ReturnType<typeof CreateMcpServerRequestSchema.parse>): Promise<McpServer>;
  check(id: Id): Promise<McpServer | null>;
  remove(id: Id): Promise<boolean>;
}

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
  /**
   * [audit S-7] The `Host` values the engine answers to (`127.0.0.1:<port>`, `localhost:<port>`,
   * `[::1]:<port>`), filled in once the real port is bound. Absent, no Host check — an app driven
   * through `app.request(...)` has no socket and so no address of its own.
   */
  selfHosts?: string[];

  /* Round 2. Optional so a round 1 harness still builds an app without them. */
  providers?: ProviderService;
  runs?: RunService;
  bus?: EventBus;

  /*
   * Round 3 (§2.5). Optional for the same reason, and the sub-routers already answer 501
   * `not_implemented` when they are handed `undefined` — so an app built without them refuses the
   * route rather than crashing on it (D121).
   */

  /** `POST /runs/:id/pause` · `/resume` · `/stop` · `/restart`, retry and re-run (FR-CTL-001..006). */
  controls?: RunControls;
  /** Domain (D309, D323): `POST /runs/:runId/messages` and `/end`. */
  domain?: DomainService;
  /** `/guardrail-policies` (FR-GRD-001, FR-GRD-010). */
  guardrailPolicies?: PolicyService;
  /** `/runs/:id/approvals`, `/node-runs/:id/approve` and `/reject` (FR-GRD-013). */
  approvals?: ApprovalService;

  /*
   * Round 4 (§2.4). Optional for the same reason the earlier rounds' services are: an app built
   * without one answers 501 `not_implemented` on the routes that need it rather than crashing.
   */

  /** `POST /artifacts`, `GET /artifacts/:id` and `/content` (FR-MM-001/002/009). */
  artifacts?: ArtifactService;
  /** `GET /tools` (FR-TOOL-001). */
  tools?: ToolCatalog;
  /** `GET/POST/DELETE /mcp-servers`, `POST /mcp-servers/:id/check` (FR-TOOL-007). */
  mcp?: McpService;
  /** The timeline and direct-chat routes (FR-CHAT-001..008). */
  chat?: ChatService;

  /*
   * Round 5 (§2.9, D235). Optional for the same reason the earlier rounds' services are: an app built
   * without one answers 501 `not_implemented` on the routes that need it (D121).
   */

  /** `/projects/:id/knowledge-bases`, `/knowledge-bases/:id`, its documents and reindex (FR-RAG-001..003, 009). */
  knowledge?: KnowledgeService;
  /** `POST /knowledge-bases/:id/query` (FR-RAG-004, FR-RAG-008). */
  search?: SearchService;
  /** `/nodes/:id/memory`: list, delete one, clear (FR-MEM-004). */
  memory?: MemoryService;
  /** `GET /runs/:id/trace` (FR-OBS-001). */
  trace?: TraceService;
  /** `GET /usage` and `GET /metrics/health` (FR-OBS-004, FR-OBS-007). */
  usage?: UsageService;
  /** `GET /templates`, `POST /templates/:id/instantiate` (FR-ONB-002). */
  templates?: TemplateService;
  /** `POST /backup/export` and `/backup/import` (FR-SYS-012). */
  backup?: BackupService;

  /*
   * IDE (D299). Optional for the same reason as every round's services: an app built without it
   * answers 501 `not_implemented` on the routes that need it (D121).
   */

  /** `/projects/:id/files/*`: Forge's project files (FR-GIT-003, FR-GIT-004, FR-GIT-008). */
  workspace?: WorkspaceService;
  /** `/projects/:id/processes/*`: Forge's terminal (D301). Agents never reach it. */
  processes?: ProcessService;
  /** `/projects/:id/checkpoints/*`: review, keep and revert agents' changes (D300). */
  checkpoints?: CheckpointService;

  /** `/bench/*`: ACE Bench's tasks, experiments, blind export, scores and report (PG-5.6). */
  bench?: BenchService;
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

/** What the Origin rule reads: the stored allow-list and the engine's own origins. */
export type OriginDeps = Pick<EngineDeps, 'repository' | 'scope' | 'selfOrigins'>;

/**
 * FR-SYS-003: may a request from this `Origin` come in? One rule for REST (`originGuard`, and
 * `corsLayer` for what the browser may read) and for the WebSocket upgrade (design §7), so the
 * three can never disagree. A missing or empty Origin is allowed: curl and the CLI send none, and
 * a page cannot forge an allowed one.
 */
export async function isOriginAllowed(
  deps: OriginDeps,
  origin: string | undefined,
): Promise<boolean> {
  if (origin === undefined || origin === '') return true;
  const settings = await deps.repository.settings.get(deps.scope);
  return settings.allowedOrigins.includes(origin) || (deps.selfOrigins ?? []).includes(origin);
}

/**
 * [audit S-7] Is `host` (a request's `Host` header) one of the engine's own addresses? The second
 * layer against DNS rebinding: a page on `evil.example` that re-points its name at 127.0.0.1 is
 * same-origin to itself, sends no `Origin` on a GET and so passes the Origin rule — but its `Host`
 * still says `evil.example`. One rule for REST (`hostGuard`) and the WebSocket upgrade. With no
 * `selfHosts` there is nothing to compare against and every host passes.
 */
export function isHostAllowed(selfHosts: readonly string[] | undefined, host: string | undefined): boolean {
  if (selfHosts === undefined) return true;
  return host !== undefined && selfHosts.includes(host.toLowerCase());
}

/** [audit S-7]: refuse a request whose `Host` is not the engine's — before CORS answers anything. */
function hostGuard(deps: EngineDeps): MiddlewareHandler<{ Variables: EngineVariables }> {
  return async (c, next) => {
    const host = c.req.header('Host');
    if (!isHostAllowed(deps.selfHosts, host)) throw forbiddenHost(host ?? '');
    return next();
  };
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
    origin: async (origin) =>
      origin !== '' && (await isOriginAllowed(deps, origin)) ? origin : null,
    // PUT: Forge's save (D299) and Domain's budget (D313).
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // Last-Event-ID: Domain's stream resumes where it stopped (D314).
    allowHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'Last-Event-ID'],
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
    if (!(await isOriginAllowed(deps, origin))) throw forbiddenOrigin(origin ?? '');
    return next();
  };
}

/** `GET /api/v1/artifacts/:id/content` — one id segment, nothing before or after (§2.1). */
const ARTIFACT_CONTENT_PATH = new RegExp(`^${API_BASE_PATH}/artifacts/[^/]+/content$`);

/**
 * Whether a request may carry the session token as `?token=` instead of the `Authorization` header
 * (round 4 §5 items 1 + 3, FR-MM-009, D-066).
 *
 * Exactly one route: `GET /artifacts/:id/content`. An `<img>`, `<audio>` or `<video>` element and a
 * download link fetch their URL themselves and cannot add a header, so `artifactContentUrl(id)`
 * (`@ace/sdk`) puts the token in the query — the same thing the WebSocket upgrade already does
 * (§2.10). Everything else, including the artifact's JSON row, still needs the header (FR-SYS-002).
 */
export function queryTokenAllowed(method: string, path: string): boolean {
  return method === 'GET' && ARTIFACT_CONTENT_PATH.test(path);
}

/**
 * FR-SYS-002 / TC-SYS-002: every route, health included, needs the session token.
 *
 * The token comes from the `Authorization` header; only when there is no header at all, and only on
 * the route {@link queryTokenAllowed} names, from `?token=`. Either way the same `Auth.verifyToken`
 * decides — the constant-time compare of `SessionTokenAuth` — so a query token is exactly as strong
 * as a header one. A header that is present decides on its own, right or wrong. The query string is
 * never logged: `onError` records `c.req.path`, which has none, and the logger masks a `token=` value
 * anywhere in a line besides (BR-07).
 */
function authGuard(deps: EngineDeps): MiddlewareHandler<{ Variables: EngineVariables }> {
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const token =
      header === undefined
        ? queryTokenAllowed(c.req.method, c.req.path)
          ? c.req.query('token')
          : undefined
        : bearerToken(header);
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
 * Map a chat-service domain error to the §2.3 envelope (round 4 §2.3). Anything that is not a chat
 * error is rethrown untouched, so a Zod parse error or an unexpected throw still reaches `onError`.
 *
 * Note on status: `chat/errors.ts` describes a not-an-agent node and a router refusal as "422",
 * but the only contract code at 422 is `guardrail_blocked`, and §2.3 fixes each code's status.
 * Keeping that code→status pairing intact, these map to `validation_failed` (400, kind
 * `invalid_config`); only a blocked input is 422 (`guardrail_blocked`, with the verdicts).
 */
function toChatHttpError(error: unknown): unknown {
  if (
    error instanceof ChatWorkflowNotFoundError ||
    error instanceof ChatNodeNotFoundError ||
    error instanceof ChatThreadNotFoundError ||
    error instanceof ChatMessageNotFoundError ||
    error instanceof ChatApprovalNotFoundError
  ) {
    return notFound(error.message.replace(/\.$/, ''));
  }
  if (
    error instanceof ChatActionInvalidError ||
    error instanceof NotAnAgentNodeError ||
    error instanceof ChatThreadNodeMismatchError ||
    error instanceof ChatTargetInvalidError
  ) {
    return new HttpError('invalid_config', 'validation_failed', error.message);
  }
  if (error instanceof ChatModelError) {
    return error.code === 'not_supported_yet'
      ? new HttpError('workflow', 'not_implemented', error.message)
      : new HttpError('invalid_config', 'validation_failed', error.message);
  }
  if (error instanceof ChatInputBlockedError) {
    return new HttpError('guardrail', 'guardrail_blocked', error.message, {
      verdicts: error.verdicts,
    });
  }
  if (error instanceof ChatRunNotAvailableError) {
    return new HttpError('workflow', 'not_implemented', error.message);
  }
  return error;
}

/** Build a `MessageQuery` from the query string, reading `type` as a repeatable parameter (§2.4). */
function messageQuery(c: Context): MessageQuery {
  const types = c.req.queries('type');
  const raw: Record<string, unknown> = {};
  const runId = c.req.query('runId');
  const nodeId = c.req.query('nodeId');
  const cursor = c.req.query('cursor');
  const limit = c.req.query('limit');
  if (runId !== undefined) raw['runId'] = runId;
  if (nodeId !== undefined) raw['nodeId'] = nodeId;
  if (types !== undefined && types.length > 0) raw['type'] = types;
  if (cursor !== undefined) raw['cursor'] = cursor;
  if (limit !== undefined) raw['limit'] = limit;
  return MessageQuerySchema.parse(raw);
}

/**
 * Parse an HTTP `Range: bytes=…` header against a body of `size` bytes (§2.1, FR-MM-009). Only a
 * single range is honoured — `start-end`, `start-` (to the end) or `-suffix` (the last N). A header
 * that is absent, malformed or unsatisfiable returns `undefined`, and the whole body is served 200.
 */
function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined {
  if (header === undefined || size === 0) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;

  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') return undefined;

  let start: number;
  let end: number;
  if (startText === '') {
    // Suffix range: the last `endText` bytes.
    const suffix = Number(endText);
    if (suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Number(endText);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  if (start > end || start >= size) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

/** A copy of the bytes as a standalone `ArrayBuffer`, which is what `c.body` accepts. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** A filename safe to put inside a quoted `Content-Disposition` (no quotes, backslashes or CR/LF). */
function safeFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '_');
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
  app.use('*', hostGuard(deps));
  app.use('*', corsLayer(deps));
  app.use('*', originGuard(deps));
  app.use('*', authGuard(deps));

  const api = new Hono<{ Variables: EngineVariables }>();

  api.get('/health', async (c) => {
    // A read that touches the database, so "db: ok" means the store really answered.
    await deps.repository.settings.get(deps.scope);

    return c.json(HealthResponseSchema.parse({ status: 'ok', version: deps.version, db: 'ok' }));
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

  const artifacts = (_c: Context): ArtifactService => {
    if (deps.artifacts === undefined) throw notImplemented('artifacts');
    return deps.artifacts;
  };

  const mcp = (_c: Context): McpService => {
    if (deps.mcp === undefined) throw notImplemented('mcp-servers');
    return deps.mcp;
  };

  const chat = (_c: Context): ChatService => {
    if (deps.chat === undefined) throw notImplemented('chat');
    return deps.chat;
  };

  api.get('/projects', async (c) => c.json(await deps.graph.listProjects(page(c))));

  api.post('/projects', async (c) => {
    const input = CreateProjectRequestSchema.parse(await readJson(c));
    return c.json(await deps.graph.createProject(input), 201);
  });

  api.get('/projects/:id', async (c) => c.json(await deps.graph.getProject(c.req.param('id'))));

  api.patch('/projects/:id', async (c) => {
    const patch = UpdateProjectRequestSchema.parse(await readJson(c));
    const id = c.req.param('id');
    // Every field of the patch, not just the name: `maxCostPerRunUsd` is the cap FR-GRD-008 halts a
    // run against, `terminal` the trust level D301 starts processes by, and `checkCommand` and
    // `formatOnSave` Forge's Run checks and format-on-save. Reading only `name` here made the
    // others unsettable through the API.
    if (
      patch.name === undefined &&
      patch.maxCostPerRunUsd === undefined &&
      patch.terminal === undefined &&
      patch.checkCommand === undefined &&
      patch.formatOnSave === undefined
    ) {
      return c.json(await deps.graph.getProject(id));
    }
    const updated = await deps.graph.updateProject(id, patch);
    // D301: off disables the terminal now, not only for new processes. Answered once all have ended.
    if (patch.terminal === 'off') await deps.processes?.stopProject(id);
    return c.json(updated);
  });

  api.delete('/projects/:id', async (c) => {
    const id = c.req.param('id');
    // D301: a deleted project's processes would run on, unseen and unstoppable: they stop first.
    await deps.processes?.stopProject(id);
    await deps.graph.deleteProject(id);
    // A start can land while the first stop waits (the project still exists then) and spawn. Once the
    // delete has committed no new start can pass, and this second stop also refuses any still in
    // flight and ends what spawned in that window, so forgetting below never orphans a process.
    await deps.processes?.stopProject(id);
    // Release the records (up to ~40 MB of output) only after the stop and the delete.
    deps.processes?.forgetProject(id);
    return c.body(null, 204);
  });

  api.post('/projects/:id/open', async (c) =>
    c.json(await deps.graph.openProject(c.req.param('id'))),
  );

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

  api.get('/workflows/:id', async (c) =>
    c.json(await deps.graph.getWorkflowGraph(c.req.param('id'))),
  );

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

  /**
   * PG-4.3: what a run of this workflow could cost, before it starts — read-only, no provider is
   * called. The caps and today's spend ride along so the start dialog can say what is left.
   */
  api.post('/workflows/:id/estimate', async (c) => {
    const { workflow, nodes, edges } = await deps.graph.getWorkflowGraph(c.req.param('id'));
    const [catalog, providerRows, project, settings] = await Promise.all([
      deps.repository.models.list(deps.scope, {}),
      deps.repository.providers.list(deps.scope),
      deps.repository.projects.get(deps.scope, workflow.projectId),
      deps.repository.settings.get(deps.scope),
    ]);
    const today = utcDay(new Date());
    const spent: { costUsd: number; costKnown?: boolean | undefined } =
      deps.usage === undefined
        ? {
            costUsd:
              (await deps.repository.nodeRuns.dailyCostUsd(deps.scope, today)) +
              ((await deps.repository.chatMessages.dailyCostUsd?.(deps.scope, today)) ?? 0),
          }
        : (await deps.usage.dayTotals(today)).totals;
    const runCap = project?.maxCostPerRunUsd;
    const dailyCap = settings.dailyBudgetUsd;
    return c.json(
      estimateWorkflow({
        workflow,
        nodes,
        edges,
        catalog,
        providers: providerRows,
        budget: {
          ...(runCap === undefined || runCap === null ? {} : { maxCostPerRunUsd: runCap }),
          ...(dailyCap === undefined || dailyCap === null ? {} : { dailyBudgetUsd: dailyCap }),
          spentTodayUsd: spent.costUsd,
          spentTodayKnown: spent.costKnown !== false,
        },
      }),
    );
  });

  api.get('/workflows/:id/export', async (c) =>
    c.json(await deps.graph.exportWorkflow(c.req.param('id'))),
  );

  /* ------------------------------------------------------------- providers */

  /**
   * Registered before `/providers/:id`, because `detect` is a word and `:id` would swallow it
   * (FR-PRV-007).
   */
  api.get('/providers/detect', async (c) => c.json(await providers(c).detect()));

  /** X1 (FR-PRV-008): the terminal scan. Three segments, so `/providers/:id` never swallows it. */
  api.get('/providers/detect/clis', async (c) => {
    const service = providers(c);
    return c.json(service.detectClis === undefined ? { items: [] } : await service.detectClis());
  });

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
    const existing = await providers(c).get(c.req.param('id'));
    if (existing === null) throw notFound(`provider ${c.req.param('id')}`);
    // A patch carries no type, so whether a key or a permission fits is decided by the stored row.
    const misfit = cliPatchError(existing.type, patch);
    if (misfit !== undefined) throw new HttpError('invalid_config', 'validation_failed', misfit);

    const provider = await providers(c).update(c.req.param('id'), patch);
    if (provider === null) throw notFound(`provider ${c.req.param('id')}`);
    return c.json(provider);
  });

  api.delete('/providers/:id', async (c) => {
    // FR-PRV-005: without `confirm=true` a provider a node still names is refused, and the
    // refusal carries the node ids so the UI can say exactly what it would break.
    const confirm = c.req.query('confirm') === 'true';
    const result = await providers(c).remove(c.req.param('id'), { confirm });

    if (!result.ok) throw providerInUse(result.nodeIds, result.knowledgeBases);
    return c.body(null, 204);
  });

  api.post('/providers/:id/check', async (c) =>
    c.json(await providers(c).check(c.req.param('id'))),
  );

  api.post('/providers/:id/refresh-models', async (c) =>
    c.json(await providers(c).refreshModels(c.req.param('id'))),
  );

  /**
   * D380 (agentic nodes P2): the person says whether a discovered model takes tools, and how big
   * its window is. Kept across a refresh. The model id is URL-encoded — ids carry `/` and `:`.
   */
  api.patch('/providers/:id/models/:modelId', async (c) => {
    const patch = ModelCapabilitiesPatchSchema.parse(await readJson(c));
    const id = c.req.param('id');
    const modelId = c.req.param('modelId');
    const model = await providers(c).setModelCapabilities(id, modelId, patch);
    if (model === null) throw notFound(`model ${modelId} of provider ${id}`);
    return c.json(model);
  });

  /* ------------------------------------------- models on this machine (PG-1.4, D359) */

  /**
   * A local-model or try call: a missing provider is 404, a provider that is not Ollama 400, and
   * a failure of the runtime or the model answered with its (masked) reason.
   */
  async function localAction<T>(
    id: string,
    action: ((id: string) => Promise<T>) | undefined,
  ): Promise<T> {
    if (action === undefined) throw notImplemented('Managing local models');
    try {
      return await action(id);
    } catch (error) {
      if (error instanceof ProviderNotFoundError) throw notFound(`provider ${id}`);
      if (error instanceof LocalModelRefusedError) {
        throw new HttpError('invalid_config', 'validation_failed', error.message);
      }
      if (error instanceof ProviderActionError) {
        throw new HttpError('provider', 'internal', error.message, undefined, true);
      }
      throw error;
    }
  }

  api.get('/local-runtime', async (c) => {
    const service = providers(c);
    if (service.localRuntime === undefined) throw notImplemented('The local runtime');
    return c.json(await service.localRuntime());
  });

  /** Start Ollama when it is installed and stopped, and add its provider when there is none. */
  api.post('/local-runtime/start', async (c) => {
    const service = providers(c);
    if (service.ensureLocalRuntime === undefined) throw notImplemented('The local runtime');
    return c.json(await service.ensureLocalRuntime());
  });

  api.get('/providers/:id/local/running', async (c) => {
    const service = providers(c);
    const items = await localAction(c.req.param('id'), service.runningLocalModels?.bind(service));
    return c.json({ items });
  });

  api.post('/providers/:id/local/load', async (c) => {
    const { modelId } = LocalModelRequestSchema.parse(await readJson(c));
    const service = providers(c);
    const load = service.loadLocalModel?.bind(service);
    return c.json(await localAction(c.req.param('id'), load && ((id) => load(id, modelId))));
  });

  api.post('/providers/:id/local/unload', async (c) => {
    const { modelId } = LocalModelRequestSchema.parse(await readJson(c));
    const service = providers(c);
    const unload = service.unloadLocalModel?.bind(service);
    return c.json(await localAction(c.req.param('id'), unload && ((id) => unload(id, modelId))));
  });

  /** 202: the pull runs on; its progress rides `model.pull` on the engine subscription. */
  api.post('/providers/:id/local/pull', async (c) => {
    const { name } = PullModelRequestSchema.parse(await readJson(c));
    const service = providers(c);
    const pull = service.pullLocalModel?.bind(service);
    return c.json(await localAction(c.req.param('id'), pull && ((id) => pull(id, name))), 202);
  });

  /** "Try this model": one call, no tools, a 60 s limit — any provider. */
  api.post('/providers/:id/try', async (c) => {
    const { modelId, prompt } = TryModelRequestSchema.parse(await readJson(c));
    const service = providers(c);
    const tryModel = service.tryModel?.bind(service);
    return c.json(
      await localAction(c.req.param('id'), tryModel && ((id) => tryModel(id, modelId, prompt))),
    );
  });

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

  api.get('/runs/:id/node-runs', async (c) =>
    c.json(await runs(c).listNodeRuns(c.req.param('id'))),
  );

  api.get('/runs/:id/events', async (c) => {
    const { afterSeq } = EventsQuerySchema.parse(c.req.query());
    const runId = c.req.param('id');

    // Scoped to this run in the query, not filtered in memory afterwards (FR-EXE-014).
    const events = await deps.repository.events.listAfter(deps.scope, afterSeq ?? 0, {
      runIds: [runId],
    });

    return c.json(
      events.map((event) => ({
        seq: event.seq,
        at: event.createdAt,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.workflowId === undefined ? {} : { workflowId: event.workflowId }),
        type: event.type,
        payload: event.payload,
      })),
    );
  });

  /*
   * PG-5.5 (FR-BEN-005): one run as a judging bundle — the run record, its node runs, each node's
   * final output and its event log. `?anonymise=1` strips node names, providers and models for
   * blind judging (TC-BEN-004). Never a secret: every string goes through the mask.
   */
  api.get('/runs/:id/export', async (c) => {
    const { anonymise } = RunExportQuerySchema.parse(c.req.query());
    const runId = c.req.param('id');
    const run = await runs(c).getRun(runId);
    const [nodeRuns, events, providerRows, models] = await Promise.all([
      runs(c).listNodeRuns(runId),
      deps.repository.events.listAfter(deps.scope, 0, { runIds: [runId] }),
      deps.repository.providers.list(deps.scope),
      deps.repository.models.list(deps.scope, {}),
    ]);
    const bundle = buildRunExport({
      run,
      nodeRuns,
      events: events.map((event) => ({
        seq: event.seq,
        at: event.createdAt,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.workflowId === undefined ? {} : { workflowId: event.workflowId }),
        type: event.type,
        payload: event.payload,
      })),
      anonymise,
      providers: providerRows,
      models,
      now: () => new Date().toISOString(),
    });
    const name = `run-${run.id}${anonymise ? '-anonymised' : ''}.json`;
    c.header('Content-Disposition', `attachment; filename="${name}"`);
    return c.json(bundle);
  });

  api.get('/node-runs/:id', async (c) => c.json(await runs(c).getNodeRun(c.req.param('id'))));

  /* -------------------------------------------------------------- artifacts (R4) */

  api.post('/artifacts', async (c) => {
    const body = await c.req.parseBody();
    const file = body[ARTIFACT_UPLOAD_FIELD];
    if (!(file instanceof File)) {
      throw new HttpError(
        'invalid_config',
        'validation_failed',
        `A multipart form field "${ARTIFACT_UPLOAD_FIELD}" carrying the file is required.`,
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const artifact = await artifacts(c).upload(bytes, { mime: file.type, name: file.name });
      return c.json(artifact, 201);
    } catch (error) {
      // The service is HTTP-free: it throws a domain error carrying the §2.1 code and details, and
      // this is the one line that turns it into the envelope (`artifacts/errors.ts`).
      if (error instanceof UploadTooLargeError || error instanceof UnsupportedTypeError) {
        throw new HttpError(error.kind, error.code, error.message, error.details);
      }
      throw error;
    }
  });

  api.get('/artifacts/:id', async (c) => {
    const artifact = await artifacts(c).get(c.req.param('id'));
    if (artifact === null) throw notFound(`artifact ${c.req.param('id')}`);
    return c.json(artifact);
  });

  api.get('/artifacts/:id/content', async (c) => {
    const found = await artifacts(c).content(c.req.param('id'));
    if (found === null) throw notFound(`artifact ${c.req.param('id')}`);
    const { artifact, bytes } = found;

    // [audit S-6]: the bytes are whatever a model or an upload produced, served on the engine's own
    // origin with the token in the URL. Never sniffed into something else, never run as a page if
    // opened as one (an <img>/<audio>/<video> ignores a subresource's CSP), never kept in a cache.
    const headers: Record<string, string> = {
      'Content-Type': artifact.mime,
      'Content-Disposition': `attachment; filename="${safeFilename(artifact.name)}"`,
      ETag: artifactETag(artifact.hash),
      'Accept-Ranges': ARTIFACT_ACCEPT_RANGES,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'no-store',
    };

    // Range → 206 with the requested slice, so audio and video can be seeked (§2.1, FR-MM-009).
    const range = parseByteRange(c.req.header('Range'), bytes.byteLength);
    if (range !== undefined) {
      const slice = bytes.slice(range.start, range.end + 1);
      return c.body(toArrayBuffer(slice), 206, {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
        'Content-Length': String(slice.byteLength),
      });
    }

    return c.body(toArrayBuffer(bytes.slice()), 200, {
      ...headers,
      'Content-Length': String(bytes.byteLength),
    });
  });

  /* ------------------------------------------------------------------- tools (R4) */

  api.get('/tools', (c) => {
    if (deps.tools === undefined) throw notImplemented('tools');
    return c.json({ items: deps.tools.list() });
  });

  api.get('/mcp-servers', async (c) => c.json({ items: await mcp(c).list() }));

  api.post('/mcp-servers', async (c) => {
    const request = CreateMcpServerRequestSchema.parse(await readJson(c));
    return c.json(await mcp(c).create(request), 201);
  });

  api.delete('/mcp-servers/:id', async (c) => {
    const removed = await mcp(c).remove(c.req.param('id'));
    if (!removed) throw notFound(`MCP server ${c.req.param('id')}`);
    return c.body(null, 204);
  });

  api.post('/mcp-servers/:id/check', async (c) => {
    const server = await mcp(c).check(c.req.param('id'));
    if (server === null) throw notFound(`MCP server ${c.req.param('id')}`);
    return c.json(server);
  });

  /* -------------------------------------------------------------- chat/timeline (R4) */

  api.get('/workflows/:id/messages', async (c) => {
    try {
      return c.json(await chat(c).listMessages(c.req.param('id'), messageQuery(c)));
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  api.post('/workflows/:id/messages', async (c) => {
    const request = PostMessageRequestSchema.parse(await readJson(c));
    try {
      return c.json(await chat(c).postMessage(c.req.param('id'), request));
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  api.post('/nodes/:id/chat', async (c) => {
    const request = ChatRequestSchema.parse(await readJson(c));
    try {
      // 202: the reply streams over the socket as `chat.token` frames ending in `chat.message`;
      // `done` is deliberately not awaited — the chat service already logs its own failure (§2.3).
      const begun = await chat(c).chat(c.req.param('id'), request);
      return c.json({ threadId: begun.threadId, messageId: begun.messageId }, 202);
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  api.get('/nodes/:id/chat/threads', async (c) =>
    c.json(await chat(c).listThreads(c.req.param('id'))),
  );

  api.get('/chat/threads/:id', async (c) => {
    try {
      return c.json(await chat(c).getThread(c.req.param('id')));
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  api.delete('/chat/threads/:id', async (c) => {
    try {
      await chat(c).deleteThread(c.req.param('id'));
      return c.body(null, 204);
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  /* PG-1.6 (D352): message actions. Retry and edit answer 202 like `POST /nodes/:id/chat`. */
  api.post('/chat/threads/:id/messages/:messageId/retry', async (c) => {
    // PG-2.4 (D361): an optional `{ withoutUndo }` — Run without undo, once.
    const request = ChatRetryRequestSchema.parse(await readJson(c));
    try {
      const begun = await chat(c).retryMessage(
        c.req.param('id'),
        c.req.param('messageId'),
        request.withoutUndo === true ? { withoutUndo: true } : {},
      );
      return c.json({ threadId: begun.threadId, messageId: begun.messageId }, 202);
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  /* PG-2.2 (D359): a chat tool call waiting on a person, and its decision. */
  api.get('/chat/threads/:id/approvals', async (c) => {
    try {
      return c.json(await chat(c).listApprovals(c.req.param('id')));
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  const decideChatApproval = (kind: 'approve' | 'reject') => async (c: Context) => {
    const { note, always } = ApprovalDecisionRequestSchema.parse(await readJson(c));
    // D376: Always allow saves an agentic node's command prefix; a chat asks about no command.
    if (always === true) throw cannotAlwaysAllow(CANNOT_ALWAYS_ALLOW);
    try {
      return c.json(
        await chat(c).decideApproval(
          c.req.param('id') ?? '',
          c.req.param('requestId') ?? '',
          kind,
          note,
        ),
      );
    } catch (error) {
      throw toChatHttpError(error);
    }
  };
  api.post('/chat/threads/:id/approvals/:requestId/approve', decideChatApproval('approve'));
  api.post('/chat/threads/:id/approvals/:requestId/reject', decideChatApproval('reject'));

  api.post('/chat/threads/:id/messages/:messageId/edit', async (c) => {
    const request = ChatEditRequestSchema.parse(await readJson(c));
    try {
      const begun = await chat(c).editMessage(
        c.req.param('id'),
        c.req.param('messageId'),
        request.content,
      );
      return c.json({ threadId: begun.threadId, messageId: begun.messageId }, 202);
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  api.delete('/chat/threads/:id/messages/:messageId', async (c) => {
    try {
      await chat(c).deleteMessage(c.req.param('id'), c.req.param('messageId'));
      return c.body(null, 204);
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  api.post('/chat/threads/:id/stop', async (c) => {
    try {
      return c.json(await chat(c).stopThread(c.req.param('id')));
    } catch (error) {
      throw toChatHttpError(error);
    }
  });

  /*
   * Round 3's routes, three sub-routers mounted with one line each (§2.5, D121). They go on before
   * `api` is mounted so they sit inside the same `/api/v1` prefix and inherit the request-id, CORS,
   * origin and auth middleware above — a route that skipped `authGuard` would be a hole in
   * FR-SYS-002.
   */
  api.route(
    '/',
    createRunControlRoutes(() => deps.controls),
  );
  api.route(
    '/',
    createDomainRoutes(() => deps.domain),
  );
  api.route('/', createGuardrailRoutes(deps.guardrailPolicies));
  api.route('/', createApprovalRoutes(deps.approvals));
  /* Round 5's routes (§2.9), mounted the same way, inside the same middleware. */
  api.route('/', createKnowledgeRoutes(deps.knowledge, deps.search));
  api.route('/', createMemoryRoutes(deps.memory));
  api.route('/', createUsageRoutes(deps.trace, deps.usage));
  api.route('/', createTemplateRoutes(deps.templates));
  api.route('/', createBackupRoutes(deps.backup));
  /* IDE (D299): Forge's project files, inside the same middleware. */
  api.route('/', createWorkspaceRoutes(deps.workspace));
  /* IDE (D301): Forge's terminal, inside the same middleware. */
  api.route('/', createProcessRoutes(deps.processes));
  /* IDE (D300): checkpoints of agents' changes, inside the same middleware. */
  api.route('/', createCheckpointRoutes(deps.checkpoints));
  /* PG-5.6: ACE Bench (Arch §20.2), inside the same middleware. */
  api.route('/', createBenchRoutes(deps.bench));

  app.route(API_BASE_PATH, api);

  app.notFound((c) => {
    const { status, body } = toApiError(notFound(`${c.req.method} ${c.req.path}`));
    return c.json(body, status as 404);
  });

  return app;
}

export { readJson } from './read-json.js';

export * from './errors.js';
