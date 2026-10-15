import {
  ARTIFACT_ACCEPT_RANGES,
  ARTIFACT_CONTENT_HEADERS,
  ARTIFACT_UPLOAD_FIELD,
  ChatEditRequestSchema,
  ChatRequestSchema,
  CreateMcpServerRequestSchema,
  MessageQuerySchema,
  PostMessageRequestSchema,
  aceError,
  allowedRunActions,
  artifactETag,
  blockedChatReply,
  isAllowedUpload,
  maxUploadBytes,
  messageMatchesQuery,
  zeroUsage,
  type ApiError,
  type ChatMessage,
  type ChatVerdict,
  type ErrorKind,
  type McpServer,
  type Message,
  type Node,
  type Part,
  type Run,
  type ToolDefinition,
} from '@ace/contracts';
import { HttpResponse, http, type HttpHandler, type PathParams } from 'msw';

import { newId } from '../lib/ulid';
import { type MockDb } from './db';
import { playScenario, preflight } from './handlers-round2';
import { cancelPlayback, pendingPlaybackSteps, startPlayback } from './playback';
import {
  BUILTIN_TOOL_DEFINITIONS,
  MCP_FIXTURE_TOOL_COUNT,
  mcpToolDefinitions,
} from './tools-catalog';

/**
 * MSW handlers for the round 4 endpoints (§2.4): artifact upload/download with an in-memory
 * content-addressed blob store, the tool registry, MCP servers, timeline messages and direct chat.
 * Registered ahead of the round 3 handlers, the way those are registered ahead of round 2's.
 *
 * The seam every other M4 web agent consumes: the shapes here match `@ace/sdk` exactly — `{ items }`
 * where the client unwraps it (`GET /tools`, `/mcp-servers`, `/messages`), a bare array where §2.4
 * writes one (`GET /nodes/:id/chat/threads`, like `GET /runs/:id/approvals`, D78).
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

function validationFailed(details: unknown) {
  return error(400, 'invalid_config', 'validation_failed', 'Request body is invalid.', details);
}

function hasToken(request: Request): boolean {
  return /^Bearer\s+\S+$/.test(request.headers.get('authorization') ?? '');
}

/** Media elements cannot send an `Authorization` header, so the content route also takes `?token=`. */
function hasTokenOrQuery(request: Request): boolean {
  if (hasToken(request)) return true;
  return Boolean(new URL(request.url).searchParams.get('token'));
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

const now = (): string => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Multipart parsing (byte level, so it works in every runtime)                */
/* -------------------------------------------------------------------------- */

/** The boundary from a `multipart/form-data; boundary=…` header, quoted or bare. */
export function boundaryOf(contentType: string | null): string | undefined {
  if (contentType === null || !/multipart\/form-data/i.test(contentType)) return undefined;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = match?.[1] ?? match?.[2];
  return value === undefined ? undefined : value.trim();
}

/** First index of `needle` in `hay` at or after `from`, byte-wise; `-1` when absent. */
function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

interface MultipartFile {
  filename?: string;
  contentType?: string;
  data: Uint8Array;
}

/**
 * The `file` part of a multipart body, bytes intact. A deliberately small reader — one file field,
 * the shape a browser `FormData` upload and the SDK's XHR both produce.
 */
export function parseMultipartFile(bytes: Uint8Array, boundary: string): MultipartFile | undefined {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const headerSeparator = encoder.encode('\r\n\r\n');

  let cursor = indexOfBytes(bytes, delimiter, 0);
  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    if (bytes[start] === 0x2d && bytes[start + 1] === 0x2d) break; // closing `--boundary--`
    if (bytes[start] === 0x0d && bytes[start + 1] === 0x0a) start += 2; // CRLF after boundary

    const headerEnd = indexOfBytes(bytes, headerSeparator, start);
    if (headerEnd === -1) break;
    const headers = decoder.decode(bytes.slice(start, headerEnd));
    const bodyStart = headerEnd + headerSeparator.length;
    const next = indexOfBytes(bytes, delimiter, bodyStart);
    const bodyEnd = next === -1 ? bytes.length : next - 2; // strip the CRLF before the next boundary

    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
    if (name === ARTIFACT_UPLOAD_FIELD && filename !== undefined) {
      return {
        filename,
        contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim(),
        data: bytes.slice(bodyStart, Math.max(bodyStart, bodyEnd)),
      };
    }
    cursor = next;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Chat scenarios (the direct-chat counterpart of round 3's approval hooks)     */
/* -------------------------------------------------------------------------- */

/**
 * Which story a direct chat tells (M4 §5.5): `chat-stream` streams a normal reply; `chat-blocked`
 * refuses the input with a 422 the way a block policy would; `chat-reply-blocked` streams nothing
 * and settles with a reply the output point blocked (FR-CHAT-008). PG-1.6: `chat-slow` streams a
 * word every second or so, long enough to press Stop.
 */
export type ChatScenario =
  'chat-stream' | 'chat-blocked' | 'chat-reply-blocked' | 'chat-fails' | 'chat-slow';

let chatScenario: ChatScenario = 'chat-stream';
export function setChatScenario(next: ChatScenario): void {
  chatScenario = next;
}
export function currentChatScenario(): ChatScenario {
  return chatScenario;
}

/**
 * Make the next chat input refuse (or stop refusing) regardless of its text — the toggle a test
 * flips to land on the FR-CHAT-008 refusal, the way round 3's `requireApproval` lands on a card.
 */
export function requireChatBlock(on = true): void {
  chatScenario = on ? 'chat-blocked' : 'chat-stream';
}

/** The phrase the demo script pastes to trip the input guardrail (FR-GRD-022, §1). */
const INJECTION_PHRASE = 'ignore previous instructions';

const textOf = (parts: readonly Part[]): string =>
  parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim();

const firstMediaName = (parts: readonly Part[]): string | undefined => {
  const media = parts.find(
    (part): part is Extract<Part, { type: 'image' | 'audio' | 'video' | 'file' }> =>
      part.type === 'image' ||
      part.type === 'audio' ||
      part.type === 'video' ||
      part.type === 'file',
  );
  return media?.name;
};

/** The reply `mock-chat` gives (§2.6): "You said: …", or French, or a note about an attachment. */
function chatReplyText(node: Node | undefined, content: Part[]): string {
  const said = textOf(content);
  const attachment = firstMediaName(content);
  if (attachment !== undefined) return `I can see the attachment ${attachment}.`;
  const instructions = (
    (node?.config as { instructions?: string } | undefined)?.instructions ?? ''
  ).toLowerCase();
  if (instructions.includes('answer in french') || instructions.includes('in french')) {
    return `Vous avez dit : ${said}`;
  }
  return `You said: ${said}`;
}

/* -------------------------------------------------------------------------- */
/* Starting a run from a posted message (FR-CHAT-003)                          */
/* -------------------------------------------------------------------------- */

/** Set the Input node's pending text to the posted message, as §2.3 requires. */
function setInputText(db: MockDb, workflowId: string, text: string): void {
  const nodes = db.nodesOf(workflowId);
  const next = nodes.map((node) =>
    node.kind === 'input' ? ({ ...node, config: { ...node.config, text } } as Node) : node,
  );
  db.commitGraph(workflowId, next, db.edgesOf(workflowId), { silent: true });
}

/** Start a run with the current scenario, exactly as `POST /workflows/:id/runs` does (D65). */
function startRun(db: MockDb, workflowId: string, projectId: string): Run {
  const nodes = db.nodesOf(workflowId);
  const workflow = db.getWorkflow(workflowId);
  const issues = preflight(
    nodes,
    db.listModels(),
    {},
    new Set(db.listProviders().map((provider) => provider.id)),
  );
  const run: Run = {
    id: newId(),
    workflowId,
    projectId,
    status: issues.length > 0 ? 'BLOCKED' : 'RUNNING',
    snapshot: { version: workflow?.version ?? 0, nodes, edges: db.edgesOf(workflowId) },
    inputs: {},
    preflightIssues: issues,
    totals: zeroUsage(),
    startedAt: now(),
    allowedActions: allowedRunActions(issues.length > 0 ? 'BLOCKED' : 'RUNNING'),
  };
  db.addRun(run);
  if (issues.length === 0) playScenario(db, run);
  return run;
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

/** The whole registry: the built-ins plus every connected MCP server's tools (FR-TOOL-001/007). */
function toolRegistry(db: MockDb): ToolDefinition[] {
  const mcp = db
    .listMcpServers()
    .filter((server) => server.status === 'connected')
    .flatMap((server) => mcpToolDefinitions(server));
  return [...BUILTIN_TOOL_DEFINITIONS, ...mcp];
}

/* -------------------------------------------------------------------------- */
/* MCP servers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Where a freshly added or re-checked server lands. A name or URL containing "unreachable" fails
 * deterministically (the same idea as the provider `checkOutcome`), so a test can drive the
 * `unreachable` chip without a real server; anything else connects with its fixture tools.
 */
function mcpOutcome(server: { name: string; url?: string }): {
  status: McpServer['status'];
  toolCount: number;
  error?: string;
} {
  if (/unreachable/i.test(server.name) || /unreachable/i.test(server.url ?? '')) {
    return { status: 'unreachable', toolCount: 0, error: 'Nothing answered at the MCP server.' };
  }
  return { status: 'connected', toolCount: MCP_FIXTURE_TOOL_COUNT };
}

function emitMcpStatus(db: MockDb, server: McpServer): void {
  db.emit({
    type: 'mcp.status',
    payload: { serverId: server.id, status: server.status, toolCount: server.toolCount },
    scope: 'engine',
  });
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

export function createRound4Handlers(db: MockDb): HttpHandler[] {
  const guard =
    (handler: (ctx: Ctx) => Response | Promise<Response>) =>
    async (ctx: Ctx): Promise<Response> => {
      if (!hasToken(ctx.request)) return unauthorized();
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));
      return handler(ctx);
    };

  return [
    /* ------------------------------------------------- artifacts (§2.1, FR-MM-001/002/009) */
    http.post(
      `${API}/artifacts`,
      guard(async ({ request }) => {
        // Parsed at the byte level rather than through `request.formData()`: undici refuses to build
        // a FormData when the `File` global is jsdom's (a cross-realm brand check), so a component
        // test could never upload. Byte parsing is the one path that works in the browser, jsdom and
        // node alike.
        const boundary = boundaryOf(request.headers.get('content-type'));
        if (boundary === undefined) return validationFailed('Expected a multipart upload.');
        const part = parseMultipartFile(new Uint8Array(await request.arrayBuffer()), boundary);
        if (part === undefined) {
          return validationFailed(`Missing the "${ARTIFACT_UPLOAD_FIELD}" file field.`);
        }
        const name = part.filename || 'upload';
        const mime = part.contentType || 'application/octet-stream';
        const bytes = part.data;

        // Over the limit before anything else, so the message names the real cap (FR-MM-001).
        const maxBytes = maxUploadBytes(db.settings.maxUploadMb);
        if (bytes.length > maxBytes) {
          return error(
            413,
            'invalid_config',
            'upload_too_large',
            `That file is ${bytes.length} bytes; the limit is ${maxBytes}.`,
            { maxBytes },
          );
        }
        if (!isAllowedUpload({ mime, name })) {
          return error(
            415,
            'invalid_config',
            'unsupported_type',
            `Files of type "${mime}" cannot be uploaded.`,
          );
        }

        const artifact = db.putArtifact({ mime, name, bytes });
        return HttpResponse.json(artifact, { status: 201 });
      }),
    ),

    http.get(
      `${API}/artifacts/:id`,
      guard((ctx) => {
        const artifact = db.getArtifact(param(ctx, 'id'));
        return artifact ? HttpResponse.json(artifact) : notFound('Artifact');
      }),
    ),

    // The content route accepts `?token=` as well as the header, for `<img>`/`<audio>`/`<video>`.
    http.get(`${API}/artifacts/:id/content`, async (ctx) => {
      if (!hasTokenOrQuery(ctx.request)) return unauthorized();
      db.load();
      if (db.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, db.latencyMs));

      const artifact = db.getArtifact(param(ctx, 'id'));
      const bytes = db.artifactBytes(param(ctx, 'id'));
      if (artifact === undefined || bytes === undefined) return notFound('Artifact');

      const headers: Record<string, string> = {
        [ARTIFACT_CONTENT_HEADERS.contentType]: artifact.mime,
        [ARTIFACT_CONTENT_HEADERS.contentDisposition]: `attachment; filename="${artifact.name}"`,
        [ARTIFACT_CONTENT_HEADERS.etag]: artifactETag(artifact.hash),
        [ARTIFACT_CONTENT_HEADERS.acceptRanges]: ARTIFACT_ACCEPT_RANGES,
      };

      // Byte-range support, so audio and video can be seeked (FR-MM-009).
      const range = ctx.request.headers.get('range');
      const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
      if (match) {
        const start = match[1] === '' ? 0 : Number(match[1]);
        const end =
          match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
        if (start > end || start >= bytes.length) {
          return new HttpResponse(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${bytes.length}` },
          });
        }
        const slice = bytes.slice(start, end + 1);
        return new HttpResponse(slice, {
          status: 206,
          headers: {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
            'Content-Length': String(slice.length),
          },
        });
      }

      return new HttpResponse(bytes, {
        status: 200,
        headers: { ...headers, 'Content-Length': String(bytes.length) },
      });
    }),

    /* ------------------------------------------------- tools (§2.2/§2.4, FR-TOOL-001) */
    http.get(
      `${API}/tools`,
      guard(() => HttpResponse.json({ items: toolRegistry(db) })),
    ),

    /* ------------------------------------------------- MCP servers (§2.2/§2.4, FR-TOOL-007) */
    http.get(
      `${API}/mcp-servers`,
      guard(() => HttpResponse.json({ items: db.listMcpServers() })),
    ),

    http.post(
      `${API}/mcp-servers`,
      guard(async (ctx) => {
        const parsed = await body(ctx.request, CreateMcpServerRequestSchema);
        if (!parsed.ok) return parsed.response;
        const outcome = mcpOutcome(parsed.data);
        const server: McpServer = {
          id: newId(),
          name: parsed.data.name,
          transport: parsed.data.transport,
          ...(parsed.data.command === undefined ? {} : { command: parsed.data.command }),
          ...(parsed.data.args === undefined ? {} : { args: parsed.data.args }),
          ...(parsed.data.url === undefined ? {} : { url: parsed.data.url }),
          status: outcome.status,
          toolCount: outcome.toolCount,
          lastCheckedAt: now(),
          ...(outcome.error === undefined ? {} : { error: outcome.error }),
        };
        db.addMcpServer(server);
        // Its tools join the registry the moment it connects, and the chip hears the same news.
        emitMcpStatus(db, server);
        return HttpResponse.json(server, { status: 201 });
      }),
    ),

    http.post(
      `${API}/mcp-servers/:id/check`,
      guard((ctx) => {
        const server = db.getMcpServer(param(ctx, 'id'));
        if (server === undefined) return notFound('MCP server');
        const outcome = mcpOutcome(server);
        const updated = db.updateMcpServer(server.id, {
          status: outcome.status,
          toolCount: outcome.toolCount,
          lastCheckedAt: now(),
          error: outcome.error,
        })!;
        emitMcpStatus(db, updated);
        return HttpResponse.json(updated);
      }),
    ),

    http.delete(
      `${API}/mcp-servers/:id`,
      guard((ctx) => {
        const id = param(ctx, 'id');
        const server = db.getMcpServer(id);
        if (server === undefined) return notFound('MCP server');
        db.deleteMcpServer(id);
        // Its tools leave the registry; the chip hears it go (toolCount 0).
        db.emit({
          type: 'mcp.status',
          payload: { serverId: id, status: 'unreachable', toolCount: 0 },
          scope: 'engine',
        });
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    /* ------------------------------------------------- timeline messages (§2.3/§2.4, FR-CHAT-001..003) */
    http.get(
      `${API}/workflows/:id/messages`,
      guard((ctx) => {
        const workflowId = param(ctx, 'id');
        if (!db.getWorkflow(workflowId)) return notFound('Workflow');
        const url = new URL(ctx.request.url);
        // `type` arrives as repeated query params; the rest are single (§2.4).
        const query = MessageQuerySchema.safeParse({
          ...Object.fromEntries(url.searchParams),
          ...(url.searchParams.getAll('type').length > 0
            ? { type: url.searchParams.getAll('type') }
            : {}),
        });
        const filter = query.success ? query.data : {};
        const all = db
          .messagesOf(workflowId)
          .filter((message) => messageMatchesQuery(message, filter));
        // the engine's default page (storage-local DEFAULT_MESSAGE_LIMIT), so a client that reads
        // one page and stops fails here as it does against the engine (D-071)
        const limit = filter.limit ?? 100;
        const offset = filter.cursor ? Number(filter.cursor) || 0 : 0;
        const slice = all.slice(offset, offset + limit);
        const nextOffset = offset + limit;
        return HttpResponse.json({
          items: slice,
          ...(nextOffset < all.length ? { nextCursor: String(nextOffset) } : {}),
        });
      }),
    ),

    http.post(
      `${API}/workflows/:id/messages`,
      guard(async (ctx) => {
        const workflowId = param(ctx, 'id');
        const workflow = db.getWorkflow(workflowId);
        if (!workflow) return notFound('Workflow');
        const parsed = await body(ctx.request, PostMessageRequestSchema);
        if (!parsed.ok) return parsed.response;

        const message: Message = {
          id: newId(),
          workflowId,
          type: 'user',
          content: parsed.data.content,
          at: now(),
        };
        db.addMessage(message);
        setInputText(db, workflowId, textOf(parsed.data.content));

        let run: Run | undefined;
        if (parsed.data.run) {
          run = startRun(db, workflowId, workflow.projectId);
          // the stored message is held by reference, so tying it to the run needs no re-insert
          message.runId = run.id;
          db.save();
        }
        db.emit({
          type: 'message.created',
          payload: { workflowId, message },
          scope: 'workflow',
          workflowId,
        });
        return HttpResponse.json(
          { message, ...(run === undefined ? {} : { run }) },
          { status: 201 },
        );
      }),
    ),

    /* ------------------------------------------------- direct chat (§2.3/§2.4, FR-CHAT-004..008) */
    http.post(
      `${API}/nodes/:id/chat`,
      guard(async (ctx) => {
        const nodeId = param(ctx, 'id');
        // a node id is unique across the workspace, so search every workflow for it
        const found = findNode(db, nodeId);
        const parsed = await body(ctx.request, ChatRequestSchema);
        if (!parsed.ok) return parsed.response;

        const inputText = textOf(parsed.data.content).toLowerCase();
        const blocked = chatScenario === 'chat-blocked' || inputText.includes(INJECTION_PHRASE);
        if (blocked) {
          const verdict: ChatVerdict = {
            id: newId(),
            point: 'input',
            checkType: 'prompt_injection',
            action: 'block',
            passed: false,
            reason: 'The message looks like a prompt-injection attempt and was refused.',
            at: now(),
          };
          return error(
            422,
            'guardrail',
            'guardrail_blocked',
            'The agent’s guardrail policy blocked this message.',
            { verdicts: [verdict] },
          );
        }

        // The engine resolves the node's model before it stores anything (D285): no model, a 400.
        if (
          found !== undefined &&
          (found.kind === 'agent' || found.kind === 'model') &&
          (found.config.providerId === undefined || found.config.modelId === undefined)
        ) {
          return error(
            400,
            'invalid_config',
            'validation_failed',
            `"${found.name}" has no provider and model chosen yet.`,
          );
        }

        // D302: another agent or model node of the same workflow may answer, in this thread.
        const targetId = parsed.data.targetNodeId;
        const speaker = targetId === undefined ? found : findNode(db, targetId);
        if (
          targetId !== undefined &&
          (speaker === undefined ||
            speaker.workflowId !== found?.workflowId ||
            (speaker.kind !== 'agent' && speaker.kind !== 'model'))
        ) {
          return error(
            400,
            'invalid_config',
            'validation_failed',
            `Node ${targetId} cannot answer in this chat.`,
          );
        }

        // Open or reuse the thread; store the user turn, whose id the client echoes while it waits.
        const threadId = parsed.data.threadId ?? openThread(db, nodeId, parsed.data.content);
        if (parsed.data.threadId !== undefined && db.getChatThread(threadId) === undefined) {
          return notFound('Chat thread');
        }
        const userMessage: ChatMessage = {
          id: newId(),
          threadId,
          role: 'user',
          content: parsed.data.content,
          verdicts: [],
          at: now(),
        };
        db.addChatMessage(userMessage);

        streamReply(db, threadId, speaker, parsed.data.content);
        return HttpResponse.json({ threadId, messageId: userMessage.id }, { status: 202 });
      }),
    ),

    http.get(
      `${API}/nodes/:id/chat/threads`,
      guard((ctx) => HttpResponse.json(db.chatThreadsOf(param(ctx, 'id')))),
    ),

    http.get(
      `${API}/chat/threads/:id`,
      guard((ctx) => {
        const thread = db.getChatThread(param(ctx, 'id'));
        if (thread === undefined) return notFound('Chat thread');
        // PG-1.6 (D352): a deleted turn is left out; a superseded one stays as an earlier version.
        const messages = db
          .chatMessagesOf(thread.id)
          .filter((message) => message.deletedAt === undefined);
        return HttpResponse.json({ thread, messages });
      }),
    ),

    /* ---------------------------------------------------- message actions (PG-1.6, D352) */
    http.post(
      `${API}/chat/threads/:id/messages/:messageId/retry`,
      guard((ctx) => {
        const threadId = param(ctx, 'id');
        const thread = db.getChatThread(threadId);
        if (thread === undefined) return notFound('Chat thread');
        const messages = db.chatMessagesOf(threadId);
        const target = messages.find((message) => message.id === param(ctx, 'messageId'));
        if (target === undefined || target.deletedAt !== undefined) return notFound('Message');
        if (target.role !== 'agent' || target.supersededAt !== undefined) {
          return error(400, 'invalid_config', 'validation_failed', 'This turn cannot be retried.');
        }
        const question = messages
          .filter(
            (message) =>
              message.role === 'user' &&
              message.id < target.id &&
              message.supersededAt === undefined &&
              message.deletedAt === undefined,
          )
          .at(-1);
        if (question === undefined) {
          return error(400, 'invalid_config', 'validation_failed', 'There is no question to ask.');
        }
        markAndAnnounce(db, target, { supersededAt: now() });
        const speaker = findNode(db, target.speakerNodeId ?? thread.nodeId);
        streamReply(db, threadId, speaker, question.content);
        return HttpResponse.json({ threadId, messageId: question.id }, { status: 202 });
      }),
    ),

    http.post(
      `${API}/chat/threads/:id/messages/:messageId/edit`,
      guard(async (ctx) => {
        const threadId = param(ctx, 'id');
        const thread = db.getChatThread(threadId);
        if (thread === undefined) return notFound('Chat thread');
        const parsed = await body(ctx.request, ChatEditRequestSchema);
        if (!parsed.ok) return parsed.response;
        const messages = db.chatMessagesOf(threadId);
        const target = messages.find((message) => message.id === param(ctx, 'messageId'));
        if (target === undefined || target.deletedAt !== undefined) return notFound('Message');
        if (target.role !== 'user' || target.supersededAt !== undefined) {
          return error(
            400,
            'invalid_config',
            'validation_failed',
            'This message cannot be edited.',
          );
        }
        const answered = messages.find(
          (message) =>
            message.role === 'agent' &&
            message.id > target.id &&
            message.supersededAt === undefined,
        );
        const at = now();
        for (const message of messages) {
          if (
            message.id >= target.id &&
            message.supersededAt === undefined &&
            message.deletedAt === undefined
          ) {
            markAndAnnounce(db, message, { supersededAt: at });
          }
        }
        const userMessage: ChatMessage = {
          id: newId(),
          threadId,
          role: 'user',
          content: parsed.data.content,
          verdicts: [],
          at: now(),
        };
        db.addChatMessage(userMessage);
        const speaker = findNode(db, answered?.speakerNodeId ?? thread.nodeId);
        streamReply(db, threadId, speaker, parsed.data.content);
        return HttpResponse.json({ threadId, messageId: userMessage.id }, { status: 202 });
      }),
    ),

    http.delete(
      `${API}/chat/threads/:id/messages/:messageId`,
      guard((ctx) => {
        const threadId = param(ctx, 'id');
        if (db.getChatThread(threadId) === undefined) return notFound('Chat thread');
        const target = db
          .chatMessagesOf(threadId)
          .find((message) => message.id === param(ctx, 'messageId'));
        if (target === undefined) return notFound('Message');
        if (target.deletedAt === undefined) markAndAnnounce(db, target, { deletedAt: now() });
        return new HttpResponse(null, { status: 204 });
      }),
    ),

    http.post(
      `${API}/chat/threads/:id/stop`,
      guard((ctx) => {
        const threadId = param(ctx, 'id');
        const thread = db.getChatThread(threadId);
        if (thread === undefined) return notFound('Chat thread');
        if (pendingPlaybackSteps(threadId) === 0) return HttpResponse.json({ stopped: false });
        cancelPlayback(threadId);
        const message: ChatMessage = {
          id: newId(),
          threadId,
          role: 'agent',
          content: [{ type: 'text', text: 'You stopped this reply before it finished.' }],
          verdicts: [],
          at: now(),
          error: {
            kind: 'user_cancelled',
            code: 'stopped',
            message: 'You stopped this reply before it finished.',
            retryable: true,
          },
          speakerNodeId: thread.nodeId,
        };
        db.addChatMessage(message);
        db.emit({
          type: 'chat.message',
          payload: { threadId, message },
          scope: 'thread',
          threadId,
        });
        return HttpResponse.json({ stopped: true });
      }),
    ),

    http.delete(
      `${API}/chat/threads/:id`,
      guard((ctx) =>
        db.deleteChatThread(param(ctx, 'id'))
          ? new HttpResponse(null, { status: 204 })
          : notFound('Chat thread'),
      ),
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* Helpers the handlers lean on                                                */
/* -------------------------------------------------------------------------- */

/** A node id is unique across the workspace; find it wherever its workflow lives. */
function findNode(db: MockDb, nodeId: string): Node | undefined {
  for (const project of db.listProjects()) {
    for (const workflow of db.listWorkflows(project.id)) {
      const node = db.nodesOf(workflow.id).find((candidate) => candidate.id === nodeId);
      if (node !== undefined) return node;
    }
  }
  return undefined;
}

/** PG-1.6 (D352): mark a turn and announce the row as it now is, as `chat.update`. */
function markAndAnnounce(
  db: MockDb,
  message: ChatMessage,
  patch: { supersededAt?: string; deletedAt?: string },
): void {
  const marked = db.markChatMessage(message.id, patch) ?? { ...message, ...patch };
  db.emit({
    type: 'chat.update',
    payload: { threadId: message.threadId, message: marked },
    scope: 'thread',
    threadId: message.threadId,
  });
}

/** Open a new thread titled after the first words of the opening message (FR-CHAT-004). */
function openThread(db: MockDb, nodeId: string, content: Part[]): string {
  const id = newId();
  const title = textOf(content).slice(0, 40) || 'New chat';
  db.addChatThread({
    id,
    nodeId,
    title,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return id;
}

/**
 * Stream the agent's reply on the thread's subscription: `chat.token` deltas, then the persisted
 * `chat.message` that settles them (FR-CHAT-006), or a single blocked message when the output point
 * refused the reply (FR-CHAT-008). The first token waits a beat so a client that subscribes right
 * after the 202 does not miss the stream.
 */
function streamReply(db: MockDb, threadId: string, node: Node | undefined, content: Part[]): void {
  if (chatScenario === 'chat-fails') {
    // The model call fails after a word or two — a signed-out CLI, say. The engine stores the
    // failure as an agent turn carrying the error and announces it like any reply (D285).
    const failure = {
      kind: 'auth' as const,
      code: 'cli_not_signed_in',
      message: 'Claude Code is not signed in — run `claude auth login`.',
      retryable: false,
    };
    const message: ChatMessage = {
      id: newId(),
      threadId,
      role: 'agent',
      content: [{ type: 'text', text: failure.message }],
      verdicts: [],
      at: new Date().toISOString(),
      error: failure,
      ...(node === undefined ? {} : { speakerNodeId: node.id }),
    };
    startPlayback(threadId, [
      {
        after: 40,
        play: () => {
          db.emit({
            type: 'chat.token',
            payload: { threadId, delta: 'Let me ' },
            scope: 'thread',
            threadId,
            transient: true,
          });
        },
      },
      {
        after: 25,
        play: () => {
          db.addChatMessage(message);
          db.emit({
            type: 'chat.message',
            payload: { threadId, message },
            scope: 'thread',
            threadId,
          });
        },
      },
    ]);
    return;
  }
  if (chatScenario === 'chat-reply-blocked') {
    const reason = 'The reply contained content the output policy blocks.';
    const verdict: ChatVerdict = {
      id: newId(),
      point: 'output',
      checkType: 'moderation',
      action: 'block',
      passed: false,
      reason,
      at: new Date().toISOString(),
    };
    const message: ChatMessage = {
      id: newId(),
      threadId,
      role: 'agent',
      content: [{ type: 'text', text: blockedChatReply(reason) }],
      verdicts: [verdict],
      at: new Date().toISOString(),
      ...(node === undefined ? {} : { speakerNodeId: node.id }),
    };
    startPlayback(threadId, [
      {
        after: 40,
        play: () => {
          db.addChatMessage(message);
          db.emit({
            type: 'chat.message',
            payload: { threadId, message },
            scope: 'thread',
            threadId,
          });
        },
      },
    ]);
    return;
  }

  const reply = chatReplyText(node, content);
  const deltas = reply.match(/\S+\s*/g) ?? [reply];
  const message: ChatMessage = {
    id: newId(),
    threadId,
    role: 'agent',
    content: [{ type: 'text', text: reply }],
    verdicts: [],
    usage: {
      tokensIn: 8,
      tokensOut: deltas.length * 2,
      costUsd: 0.00001,
      priceTableVersion: 'mock-v1',
    },
    at: new Date().toISOString(),
    ...(node === undefined ? {} : { speakerNodeId: node.id }),
  };

  const slow = chatScenario === 'chat-slow';
  startPlayback(threadId, [
    ...deltas.map((delta, index) => ({
      after: index === 0 ? 40 : slow ? 1_000 : 25,
      play: () => {
        db.emit({
          type: 'chat.token',
          payload: { threadId, delta },
          scope: 'thread',
          threadId,
          transient: true,
        });
      },
    })),
    {
      after: 25,
      play: () => {
        db.addChatMessage(message);
        db.emit({
          type: 'chat.message',
          payload: { threadId, message },
          scope: 'thread',
          threadId,
        });
      },
    },
  ]);
}
