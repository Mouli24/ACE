import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandApproval, GenerateRequest } from '../../adapter.js';

/**
 * D403: how a coding-agent CLI at `edit_commands` asks before a command its allowed commands do not
 * cover. Claude Code in print mode cannot prompt anyone, but it hands each permission it would ask
 * for to an MCP tool (`--permission-prompt-tool`). The bridge is that tool: a one-call MCP server on
 * the loopback interface, behind a random path, that turns a `Bash` request into the engine's
 * `approveCommand` — the person's approval card — and answers allow or deny. It speaks only the
 * slice of MCP's streamable HTTP transport a client needs to call one tool.
 */

export type CommandApprover = NonNullable<GenerateRequest['approveCommand']>;

const SERVER_NAME = 'ace';
const TOOL = 'approve';
/** The name Claude Code knows the tool by: `mcp__<server>__<tool>`. */
export const APPROVAL_TOOL_NAME = `mcp__${SERVER_NAME}__${TOOL}`;

/** How long the CLI may wait on one approval: as long as the person takes (the turn's clock still runs). */
export const APPROVAL_WAIT_MS = 24 * 60 * 60 * 1000;

/** The largest request the bridge reads; a permission request is a few hundred bytes. */
const MAX_BODY_BYTES = 1_000_000;

export interface ApprovalBridge {
  /** The `--mcp-config` file that names the bridge. */
  configPath: string;
  /** The `--permission-prompt-tool` name. */
  toolName: string;
  close(): void;
}

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What Claude Code reads back from the tool: run the call as asked, or refuse it with a reason. */
type PermissionAnswer =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

async function decide(args: unknown, approve: CommandApprover): Promise<PermissionAnswer> {
  const request = isObject(args) ? args : {};
  const tool = typeof request['tool_name'] === 'string' ? request['tool_name'] : 'a tool';
  const input = isObject(request['input']) ? request['input'] : {};
  const command = input['command'];
  // Only commands are asked about; anything else the level does not pre-approve stays refused.
  if (tool !== 'Bash' || typeof command !== 'string') {
    return { behavior: 'deny', message: `${tool} is not allowed at this workspace access level.` };
  }
  let approval: CommandApproval;
  try {
    approval = await approve(command);
  } catch {
    approval = { allow: false, message: 'The command could not be put to the person, so it was not run.' };
  }
  return approval.allow
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: approval.message ?? 'The person denied this command.' };
}

async function answer(message: JsonRpcMessage, approve: CommandApprover): Promise<unknown> {
  const params = isObject(message.params) ? message.params : {};
  switch (message.method) {
    case 'initialize':
      return {
        protocolVersion:
          typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: [
          {
            name: TOOL,
            description: "Asks the person whether a command may run. ACE's, not for the model.",
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
                tool_use_id: { type: 'string' },
              },
              required: ['tool_name', 'input'],
            },
          },
        ],
      };
    case 'tools/call': {
      if (params['name'] !== TOOL) throw new Error(`Unknown tool: ${String(params['name'])}`);
      const decided = await decide(params['arguments'], approve);
      return { content: [{ type: 'text', text: JSON.stringify(decided) }] };
    }
    default:
      throw Object.assign(new Error(`Method not found: ${String(message.method)}`), { code: -32601 });
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('request too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  approve: CommandApprover,
): Promise<void> {
  if (req.url !== path) {
    res.writeHead(404).end();
    return;
  }
  // No server-to-client stream: everything the bridge says is a response to a request.
  if (req.method !== 'POST') {
    res.writeHead(req.method === 'DELETE' ? 200 : 405, { Allow: 'POST' }).end();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }

  const messages = (Array.isArray(parsed) ? parsed : [parsed]).filter(isObject) as JsonRpcMessage[];
  const replies: unknown[] = [];
  for (const message of messages) {
    // A notification (no id) is acknowledged by the status alone.
    if (message.id === undefined || message.id === null) continue;
    try {
      replies.push({ jsonrpc: '2.0', id: message.id, result: await answer(message, approve) });
    } catch (error) {
      const code = isObject(error) && typeof error['code'] === 'number' ? error['code'] : -32603;
      const text = error instanceof Error ? error.message : String(error);
      replies.push({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
    }
  }

  if (replies.length === 0) {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]));
}

/** Starts the bridge for one CLI call; `close` it when the call ends, whatever happened. */
export async function startApprovalBridge(approve: CommandApprover): Promise<ApprovalBridge> {
  const path = `/${randomBytes(24).toString('hex')}`;
  const server = createServer((req, res) => {
    void handle(req, res, path, approve).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  // A permission request waits on a person: the socket must not time out under it.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  const folder = mkdtempSync(join(tmpdir(), 'ace-approvals-'));
  const configPath = join(folder, 'mcp.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: { [SERVER_NAME]: { type: 'http', url: `http://127.0.0.1:${port}${path}` } },
    }),
  );

  return {
    configPath,
    toolName: APPROVAL_TOOL_NAME,
    close() {
      server.closeAllConnections();
      server.close();
      try {
        rmSync(folder, { recursive: true, force: true });
      } catch {
        // The OS reclaims temp itself.
      }
    },
  };
}
