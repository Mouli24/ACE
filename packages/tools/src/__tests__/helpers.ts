import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_SCOPE, type Scope } from '@ace/engine';

import { RecordingToolLogger } from '../logging.js';
import { type ToolContext } from '../tool.js';

/** A ULID that satisfies `IdSchema`, for MCP server ids in tests. */
export const TEST_MCP_SERVER_ID = '01J9ZS0ABCDEFGHJKMNPQRSTVW';

/** A `ToolContext` over a fresh sandbox folder and a recording logger the test can assert on. */
export function makeContext(overrides: Partial<ToolContext> = {}): ToolContext & {
  logger: RecordingToolLogger;
  cleanup: () => void;
} {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'ace-tool-ctx-'));
  const logger = new RecordingToolLogger();
  const scope: Scope = LOCAL_SCOPE;
  return {
    scope,
    runId: 'run-test',
    ...overrides,
    // After the spread, so `logger` keeps its concrete type and `sandboxDir` is the one we clean up.
    sandboxDir,
    logger,
    // A timed-out child is settled after KILL_GRACE_MS even if Windows taskkill is still running,
    // and until it exits it holds the folder open: allow ~2 s of retries, not 0.5 s.
    cleanup: () => rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 }),
  };
}

/** Starts an HTTP server on 127.0.0.1 and resolves once it is listening. */
export async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Writes a stdio MCP server as a node script and returns its path. It speaks newline-delimited
 * JSON-RPC and advertises two tools: `reverse` (text → reversed) and `wipe` (annotated destructive).
 */
export function writeStdioMcpFixture(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ace-mcp-'));
  const path = join(dir, 'server.mjs');
  writeFileSync(path, STDIO_MCP_SERVER, 'utf8');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

const STDIO_MCP_SERVER = `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf('\\n');
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(line);
    nl = buffer.indexOf('\\n');
  }
});
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n'); }
function handle(line) {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined) return; // notification
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [
      { name: 'reverse', description: 'Reverses text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'wipe', description: 'Deletes things', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } },
    ] } });
  } else if (req.method === 'tools/call') {
    const name = req.params && req.params.name;
    if (name === 'reverse') {
      const text = String((req.params.arguments || {}).text || '');
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: text.split('').reverse().join('') }] } });
    } else if (name === 'wipe') {
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'wiped' }] } });
    } else {
      send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'unknown' }], isError: true } });
    }
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  }
}
`;
