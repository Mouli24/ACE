import type {
  Artifact,
  ChatMessage,
  ChatResponse,
  ChatThread,
  ChatThreadDetail,
  McpServer,
  Message,
  Run,
  ToolDefinition,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createAceClient, type UploadProgress } from '../index.js';

const P = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const R = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const ART = '01ARZ3NDEKTSV4RRFFQ69G5FD0';
const MCP = '01ARZ3NDEKTSV4RRFFQ69G5FD1';
const MSG = '01ARZ3NDEKTSV4RRFFQ69G5FD2';
const TH = '01ARZ3NDEKTSV4RRFFQ69G5FD3';
const CM = '01ARZ3NDEKTSV4RRFFQ69G5FD4';
const NOW = '2026-09-29T00:00:00.000Z';
const HASH = 'a'.repeat(64);

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** The recorder from the round 2/3 client tests, with a status per response. */
function recorder(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const next = responses.shift() ?? { body: {} };
    const status = next.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const paths = (calls: Call[]): string[] =>
  calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`);

/** A WebSocket-style double for `XMLHttpRequest`: the test drives progress and the response. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  method?: string;
  url?: string;
  responseType = '';
  status = 0;
  responseText = '';
  sentBody: unknown;
  aborted = false;
  readonly headers: Record<string, string> = {};
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string): void {
    this.headers[key.toLowerCase()] = value;
  }
  send(body: unknown): void {
    this.sentBody = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  /* server side */
  emitProgress(loaded: number, total: number, lengthComputable = true): void {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }
  respond(status: number, body?: unknown): void {
    this.status = status;
    this.responseText = body === undefined ? '' : JSON.stringify(body);
    this.onload?.();
  }
  fail(): void {
    this.onerror?.();
  }
}

function uploadClient() {
  FakeXHR.instances = [];
  const client = createAceClient({
    baseUrl: 'http://x',
    token: 't',
    XMLHttpRequest: FakeXHR as unknown as typeof XMLHttpRequest,
  });
  const latest = (): FakeXHR => {
    const xhr = FakeXHR.instances.at(-1);
    if (!xhr) throw new Error('no xhr');
    return xhr;
  };
  return { client, latest };
}

const artifact: Artifact = {
  id: ART,
  hash: HASH,
  mime: 'image/png',
  name: 'sample.png',
  size: 1234,
  createdAt: NOW,
};

const tool: ToolDefinition = {
  name: 'echo',
  description: 'echoes its input',
  inputSchema: {},
  outputSchema: {},
  permissions: { network: false, fsPaths: [], destructive: false },
  timeoutMs: 1000,
  source: 'builtin',
};

const mcp: McpServer = {
  id: MCP,
  name: 'local-test',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  status: 'connected',
  toolCount: 2,
  lastCheckedAt: NOW,
};

const message: Message = {
  id: MSG,
  workflowId: W,
  type: 'user',
  content: [{ type: 'text', text: 'hello' }],
  at: NOW,
};

const run: Run = {
  id: R,
  workflowId: W,
  projectId: P,
  status: 'RUNNING',
  snapshot: { version: 1, nodes: [], edges: [] },
  inputs: {},
  preflightIssues: [],
  totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  startedAt: NOW,
  allowedActions: ['pause', 'stop'],
};

const thread: ChatThread = { id: TH, nodeId: NODE, title: 'Chat', createdAt: NOW, updatedAt: NOW };

const chatMessage: ChatMessage = {
  id: CM,
  threadId: TH,
  role: 'agent',
  content: [{ type: 'text', text: 'You said: hi' }],
  verdicts: [],
  at: NOW,
};

const chatDetail: ChatThreadDetail = { thread, messages: [chatMessage] };

const chatResponse: ChatResponse = { threadId: TH, messageId: MSG };

describe('TC-MM-001/002 uploadArtifact (round 4 §2.1, M4 §2, FR-MM-001)', () => {
  it('POSTs multipart to /artifacts with the bearer token, reports progress, parses the Artifact', async () => {
    const { client, latest } = uploadClient();
    const file = new Blob([new Uint8Array(1234)], { type: 'image/png' });
    const progress: UploadProgress[] = [];

    const promise = client.uploadArtifact(file, {
      filename: 'sample.png',
      onProgress: (p) => progress.push(p),
    });
    const xhr = latest();
    xhr.emitProgress(617, 1234);
    xhr.emitProgress(1234, 1234);
    xhr.respond(201, artifact);

    expect(await promise).toEqual(artifact);
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('http://x/api/v1/artifacts');
    expect(xhr.headers.authorization).toBe('Bearer t');
    // the browser must set the multipart boundary itself, so the client never names content-type
    expect(xhr.headers['content-type']).toBeUndefined();
    expect(xhr.sentBody).toBeInstanceOf(FormData);
    const form = xhr.sentBody as FormData;
    expect((form.get('file') as File).name).toBe('sample.png');
    expect(progress.at(0)).toEqual({ loaded: 617, total: 1234, ratio: 617 / 1234 });
    expect(progress.at(-1)).toEqual({ loaded: 1234, total: 1234, ratio: 1 });
  });

  it('maps 413 to upload_too_large from the engine envelope', async () => {
    const { client, latest } = uploadClient();
    const promise = client.uploadArtifact(new Blob(['x']));
    latest().respond(413, {
      error: {
        kind: 'invalid_config',
        code: 'upload_too_large',
        message: 'too big',
        details: { maxBytes: 100 },
        retryable: false,
      },
    });
    const error = await promise.catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 413,
      code: 'upload_too_large',
      details: { maxBytes: 100 },
    });
  });

  it('maps 413/415 even when the engine sent no error envelope', async () => {
    const tooLarge = uploadClient();
    const p1 = tooLarge.client.uploadArtifact(new Blob(['x']));
    tooLarge.latest().respond(413);
    expect(await p1.catch((e: unknown) => e)).toMatchObject({
      code: 'upload_too_large',
      status: 413,
    });

    const badType = uploadClient();
    const p2 = badType.client.uploadArtifact(new Blob(['x']));
    badType.latest().respond(415);
    expect(await p2.catch((e: unknown) => e)).toMatchObject({
      code: 'unsupported_type',
      status: 415,
    });
  });

  it('a transport failure becomes a network AceApiError', async () => {
    const { client, latest } = uploadClient();
    const promise = client.uploadArtifact(new Blob(['x']));
    latest().fail();
    expect(await promise.catch((e: unknown) => e)).toMatchObject({ kind: 'network', status: 0 });
  });

  it('a 2xx body that is not an Artifact is an invalid_response', async () => {
    const { client, latest } = uploadClient();
    const promise = client.uploadArtifact(new Blob(['x']));
    latest().respond(201, { id: ART });
    expect(await promise.catch((e: unknown) => e)).toMatchObject({ code: 'invalid_response' });
  });

  it('a Blob with no filename is still sent under the file field', async () => {
    const { client, latest } = uploadClient();
    const promise = client.uploadArtifact(new Blob([new Uint8Array(4)], { type: 'text/plain' }));
    const xhr = latest();
    xhr.respond(201, artifact);
    await promise;
    expect((xhr.sentBody as FormData).get('file')).toBeInstanceOf(Blob);
  });

  it('rejects with a network error when no XMLHttpRequest is available', async () => {
    // no `XMLHttpRequest` option, and none on globalThis in the Node test host
    const client = createAceClient({ baseUrl: 'http://x', token: 't', fetch });
    const error = await client.uploadArtifact(new Blob(['x'])).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'network', status: 0 });
  });

  it('aborts the upload when the signal fires', async () => {
    const { client, latest } = uploadClient();
    const controller = new AbortController();
    const promise = client.uploadArtifact(new Blob(['x']), { signal: controller.signal });
    controller.abort();
    expect(latest().aborted).toBe(true);
    expect(await promise.catch((e: unknown) => e)).toMatchObject({ kind: 'network', status: 0 });
  });
});

describe('artifactContentUrl (round 4 §2.1, M4 §2)', () => {
  it('adds the session token as a query param so media elements can load it', () => {
    const { client } = uploadClient();
    expect(client.artifactContentUrl(ART)).toBe(`http://x/api/v1/artifacts/${ART}/content?token=t`);
  });

  it('getArtifact reads the row', async () => {
    const { calls, client } = recorder([{ body: artifact }]);
    expect(await client.getArtifact(ART)).toEqual(artifact);
    expect(paths(calls)).toEqual([`GET /artifacts/${ART}`]);
  });
});

describe('TC-TOOL-001/007 tools and MCP servers (round 4 §2.2/§2.4)', () => {
  it('lists tools as { items }', async () => {
    const { calls, client } = recorder([{ body: { items: [tool] } }]);
    const list = await client.listTools();
    expect(list.items).toEqual([tool]);
    expect(paths(calls)).toEqual(['GET /tools']);
  });

  it('lists, creates, checks and removes MCP servers', async () => {
    const { calls, client } = recorder([
      { body: { items: [mcp] } },
      { body: { ...mcp, status: 'starting', toolCount: 0 } },
      { body: mcp },
      { status: 204 },
    ]);

    const list = await client.listMcpServers();
    const created = await client.createMcpServer({
      name: 'local-test',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    const checked = await client.checkMcpServer(MCP);
    await expect(client.deleteMcpServer(MCP)).resolves.toBeUndefined();

    expect(list.items).toEqual([mcp]);
    expect(created.status).toBe('starting');
    expect(checked.toolCount).toBe(2);
    expect(paths(calls)).toEqual([
      'GET /mcp-servers',
      'POST /mcp-servers',
      `POST /mcp-servers/${MCP}/check`,
      `DELETE /mcp-servers/${MCP}`,
    ]);
    expect(calls[1]?.body).toEqual({
      name: 'local-test',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
  });

  it('an http MCP server that carries a command is refused before it is sent', async () => {
    const { client } = recorder([{ body: mcp }]);
    const error = await client
      .createMcpServer({ name: 'x', transport: 'http', command: 'node' } as never)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'validation_failed', status: 0 });
  });
});

describe('TC-CHAT-001/002/003 timeline messages (round 4 §2.3/§2.4)', () => {
  it('lists messages with combinable, repeated filters', async () => {
    const { calls, client } = recorder([{ body: { items: [message] } }]);
    const list = await client.listMessages(W, {
      runId: R,
      nodeId: NODE,
      type: ['user', 'error'],
      limit: 50,
    });
    expect(list.items).toEqual([message]);
    expect(calls[0]?.url).toBe(
      `http://x/api/v1/workflows/${W}/messages?runId=${R}&nodeId=${NODE}&type=user&type=error&limit=50`,
    );
  });

  it('posts a message and gets back the message plus the run it started', async () => {
    const { calls, client } = recorder([{ body: { message, run } }]);
    const result = await client.postMessage(W, {
      content: [{ type: 'text', text: 'hello' }],
      run: true,
    });
    expect(result.message).toEqual(message);
    expect(result.run?.status).toBe('RUNNING');
    expect(paths(calls)).toEqual([`POST /workflows/${W}/messages`]);
    expect(calls[0]?.body).toEqual({ content: [{ type: 'text', text: 'hello' }], run: true });
  });

  it('a message with empty content is refused before it is sent', async () => {
    const { client } = recorder([{ body: { message } }]);
    const error = await client.postMessage(W, { content: [], run: false }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'validation_failed', status: 0 });
  });
});

describe('TC-CHAT-004/006 direct agent chat (round 4 §2.3/§2.4)', () => {
  it('posts a chat turn and receives the 202 { threadId, messageId }', async () => {
    const { calls, client } = recorder([{ status: 202, body: chatResponse }]);
    const started = await client.postNodeChat(NODE, {
      threadId: TH,
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(started).toEqual(chatResponse);
    expect(paths(calls)).toEqual([`POST /nodes/${NODE}/chat`]);
    expect(calls[0]?.body).toEqual({ threadId: TH, content: [{ type: 'text', text: 'hi' }] });
  });

  it('lists a node threads as a bare array, reads one, deletes one', async () => {
    const { calls, client } = recorder([{ body: [thread] }, { body: chatDetail }, { status: 204 }]);

    const threads = await client.listNodeChatThreads(NODE);
    const detail = await client.getChatThread(TH);
    await expect(client.deleteChatThread(TH)).resolves.toBeUndefined();

    expect(threads).toEqual([thread]);
    expect(detail.messages).toEqual([chatMessage]);
    expect(paths(calls)).toEqual([
      `GET /nodes/${NODE}/chat/threads`,
      `GET /chat/threads/${TH}`,
      `DELETE /chat/threads/${TH}`,
    ]);
  });
});
