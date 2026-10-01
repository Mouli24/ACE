import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ToolError } from '../errors.js';
import { startHttpServer } from '../__tests__/helpers.js';
import { HttpTransport, StdioTransport } from './transport.js';

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

/**
 * A stdio server that: prints a non-JSON log line first, replies to `ping` split across two writes,
 * emits an unsolicited notification, returns an error for `boom`, and never answers `hang`.
 */
function writeQuirkyServer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ace-mcp-q-'));
  const path = join(dir, 'q.mjs');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 }));
  writeFileSync(
    path,
    `
process.stdout.write('a plain log line, not JSON\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c; let nl = buf.indexOf('\\n');
  while (nl !== -1) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) handle(line); nl = buf.indexOf('\\n'); }
});
function handle(line) {
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  if (req.method === 'ping') {
    process.stdout.write('{"jsonrpc":"2.0","method":"note","params":{}}\\n');
    process.stdout.write('{"jsonrpc":"2.0","id":' + req.id + ',"resu');
    setTimeout(() => process.stdout.write('lt":{"ok":true}}\\n'), 10);
  } else if (req.method === 'boom') {
    process.stdout.write('{"jsonrpc":"2.0","id":' + req.id + ',"error":{"code":-1,"message":"nope"}}\\n');
  }
}
`,
    'utf8',
  );
  return path;
}

describe('StdioTransport', () => {
  it('buffers split frames, ignores log noise and unsolicited notifications', async () => {
    const transport = new StdioTransport(process.execPath, [writeQuirkyServer()]);
    cleanups.push(() => transport.close());
    await expect(transport.request('ping', {}, 5_000)).resolves.toEqual({ ok: true });
  });

  it('rejects on a JSON-RPC error frame', async () => {
    const transport = new StdioTransport(process.execPath, [writeQuirkyServer()]);
    cleanups.push(() => transport.close());
    await expect(transport.request('boom', {}, 5_000)).rejects.toBeInstanceOf(ToolError);
  });

  it('times out a request the server never answers', async () => {
    const transport = new StdioTransport(process.execPath, [writeQuirkyServer()]);
    cleanups.push(() => transport.close());
    await expect(transport.request('hang', {}, 150)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('fails pending requests when closed', async () => {
    const transport = new StdioTransport(process.execPath, [writeQuirkyServer()]);
    const pending = transport.request('hang', {}, 5_000);
    await transport.close();
    await expect(pending).rejects.toBeInstanceOf(ToolError);
    await expect(transport.request('ping', {}, 1_000)).rejects.toBeInstanceOf(ToolError);
  });
});

describe('HttpTransport', () => {
  it('reads a JSON-RPC result out of an SSE frame', async () => {
    const server = await startHttpServer((_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
    });
    cleanups.push(server.close);
    await expect(new HttpTransport(server.url).request('m', {}, 5_000)).resolves.toEqual({ ok: true });
  });

  it('rejects on a non-2xx status', async () => {
    const server = await startHttpServer((_req, res) => {
      res.statusCode = 503;
      res.end('down');
    });
    cleanups.push(server.close);
    await expect(new HttpTransport(server.url).request('m', {}, 5_000)).rejects.toMatchObject({ kind: 'failed' });
  });

  it('rejects on an error frame and on a bodyless response', async () => {
    const errorServer = await startHttpServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"no"}}');
    });
    cleanups.push(errorServer.close);
    await expect(new HttpTransport(errorServer.url).request('m', {}, 5_000)).rejects.toBeInstanceOf(ToolError);

    const emptyServer = await startHttpServer((_req, res) => res.end(''));
    cleanups.push(emptyServer.close);
    await expect(new HttpTransport(emptyServer.url).request('m', {}, 5_000)).rejects.toBeInstanceOf(ToolError);
  });

  it('sends a notification best-effort and closes cleanly', async () => {
    let sawNotify = false;
    const server = await startHttpServer((req, res) => {
      sawNotify = true;
      void req;
      res.statusCode = 202;
      res.end();
    });
    cleanups.push(server.close);
    const transport = new HttpTransport(server.url);
    await transport.notify('n', {});
    await transport.close();
    expect(sawNotify).toBe(true);
  });
});
