import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { ToolError } from '../errors.js';

/**
 * The JSON-RPC 2.0 transports an MCP client speaks (D16, FR-TOOL-007). Two, matching the contract's
 * `McpTransport`: `stdio` (the engine spawns the server and talks over its pipes) and `http` (the
 * engine POSTs to a URL). Both are newline/JSON framed here — no external MCP SDK — so the tool
 * layer stays dependency-free and a test can stand up a server in a few lines.
 *
 * A transport is request/response by `id`, with fire-and-forget `notify` for MCP's notifications
 * (`notifications/initialized`). Every request carries a timeout so a silent server cannot wedge the
 * connect or a tool call.
 */

export interface McpTransport {
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcEnvelope(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

/** Talks to a spawned MCP server over its stdio pipes, one JSON message per line. */
export class StdioTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private closed = false;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.on('exit', () => this.failAll('The MCP server process exited.'));
    this.child.on('error', (error) => this.failAll((error as Error).message));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return; // A log line the server printed, not a JSON-RPC frame.
    }
    if (message.id === undefined) return; // A notification from the server; nothing awaits it.
    const waiter = this.pending.get(Number(message.id));
    if (waiter === undefined) return;
    this.pending.delete(Number(message.id));
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new ToolError('failed', 'mcp', `MCP error ${message.error.code}: ${message.error.message}`, {}));
    } else {
      waiter.resolve(message.result);
    }
  }

  private failAll(reason: string): void {
    this.closed = true;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new ToolError('failed', 'mcp', reason, {}));
    }
    this.pending.clear();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new ToolError('failed', 'mcp', 'The MCP connection is closed.', {}));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError('timeout', 'mcp', `MCP ${method} timed out after ${timeoutMs} ms.`, { method }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(rpcEnvelope(id, method, params));
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): Promise<void> {
    this.closed = true;
    this.failAll('The MCP connection was closed.');
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      // Already gone.
    }
    return Promise.resolve();
  }
}

/** Talks to an MCP server over HTTP, POSTing JSON-RPC and accepting JSON or an SSE `data:` frame. */
export class HttpTransport implements McpTransport {
  private nextId = 1;

  constructor(private readonly url: string) {}

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const aborted = (error as { name?: string }).name === 'TimeoutError';
      throw new ToolError(aborted ? 'timeout' : 'failed', 'mcp', `MCP ${method} failed: ${(error as Error).message}`, {
        method,
      });
    }
    if (!response.ok) {
      throw new ToolError('failed', 'mcp', `MCP server answered ${response.status}.`, { status: response.status });
    }

    const message = parseJsonOrSse(await response.text());
    if (message.error) {
      throw new ToolError('failed', 'mcp', `MCP error ${message.error.code}: ${message.error.message}`, {});
    }
    return message.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    try {
      await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Notifications are best-effort.
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Reads a JSON-RPC response from either a bare JSON body or an SSE stream's `data:` lines. */
function parseJsonOrSse(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as JsonRpcResponse;

  for (const line of trimmed.split('\n')) {
    const data = line.trim();
    if (data.startsWith('data:')) {
      const payload = data.slice('data:'.length).trim();
      if (payload.startsWith('{')) return JSON.parse(payload) as JsonRpcResponse;
    }
  }
  throw new ToolError('failed', 'mcp', 'The MCP server did not return a JSON-RPC response.', {});
}
