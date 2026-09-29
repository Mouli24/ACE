import { type JsonSchema } from '@ace/contracts';

import { ToolError } from '../errors.js';
import { HttpTransport, StdioTransport, type McpTransport } from './transport.js';

/**
 * A minimal MCP client (D16, FR-TOOL-007, FR-TOOL-008 excluded this round). It does the three things
 * the engine needs of a connected server: handshake (`initialize`), discover its tools
 * (`tools/list`), and call one (`tools/call`) — plus a `ping` for the health check behind
 * `POST /mcp-servers/:id/check` and `mcp.status`.
 *
 * The MCP protocol version is pinned; a server that speaks a version we do not is still allowed to
 * proceed, because `tools/list` and `tools/call` are stable across the versions we target and a
 * hard version gate would make the connect brittle for no safety gain.
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;

/** One tool a server advertises, as `tools/list` returns it. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** MCP annotations; `destructiveHint` maps to the tool's `destructive` permission. */
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
}

/** What a `tools/call` returned, flattened to text (the model reads it as untrusted content). */
export interface McpCallResult {
  text: string;
  isError: boolean;
}

export interface McpConnectOptions {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  timeoutMs?: number;
}

export class McpClient {
  private constructor(
    private readonly transport: McpTransport,
    private readonly timeoutMs: number,
  ) {}

  /** Connects, handshakes, and returns a ready client. Throws a `failed`/`timeout` ToolError if not. */
  static async connect(options: McpConnectOptions): Promise<McpClient> {
    const timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
    const transport = McpClient.openTransport(options);
    const client = new McpClient(transport, timeoutMs);

    try {
      await transport.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ace', version: '0.0.0' },
        },
        timeoutMs,
      );
      transport.notify('notifications/initialized', {});
    } catch (error) {
      await transport.close();
      throw error;
    }
    return client;
  }

  private static openTransport(options: McpConnectOptions): McpTransport {
    if (options.transport === 'stdio') {
      if (options.command === undefined) {
        throw new ToolError('unavailable', 'mcp', 'A stdio MCP server needs a command.', {});
      }
      return new StdioTransport(options.command, options.args ?? []);
    }
    if (options.url === undefined) {
      throw new ToolError('unavailable', 'mcp', 'An http MCP server needs a url.', {});
    }
    return new HttpTransport(options.url);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.transport.request('tools/list', {}, this.timeoutMs)) as {
      tools?: unknown;
    };
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return tools.map((raw) => {
      const row = raw as Partial<McpToolInfo> & { inputSchema?: unknown };
      return {
        name: typeof row.name === 'string' ? row.name : '',
        description: typeof row.description === 'string' ? row.description : '',
        inputSchema:
          row.inputSchema !== null && typeof row.inputSchema === 'object'
            ? (row.inputSchema as JsonSchema)
            : { type: 'object' },
        outputSchema: row.outputSchema,
        annotations: row.annotations,
      };
    });
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const result = (await this.transport.request(
      'tools/call',
      { name, arguments: args ?? {} },
      this.timeoutMs,
    )) as { content?: unknown; isError?: boolean };

    const parts = Array.isArray(result.content) ? result.content : [];
    const text = parts
      .map((part) => {
        const row = part as { type?: string; text?: string };
        return row.type === 'text' && typeof row.text === 'string' ? row.text : '';
      })
      .filter((piece) => piece.length > 0)
      .join('\n');

    return { text, isError: result.isError === true };
  }

  /** A liveness check for `POST /mcp-servers/:id/check` and `mcp.status`. */
  async ping(): Promise<boolean> {
    try {
      await this.transport.request('tools/list', {}, Math.min(this.timeoutMs, 5_000));
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
