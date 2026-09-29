import {
  type CreateMcpServerRequest,
  type McpServer,
  type McpServerStatus,
  type ToolDefinition,
} from '@ace/contracts';

import { isToolError } from '../errors.js';
import { ToolError } from '../errors.js';
import { type ToolRegistry } from '../registry.js';
import { type ToolImplementation } from '../tool.js';
import { McpClient, type McpToolInfo } from './client.js';

/**
 * Connects MCP servers and puts their tools in the registry (D16, FR-TOOL-007). One manager owns
 * every connection; the engine calls it from `POST/GET/DELETE /mcp-servers` and
 * `POST /mcp-servers/:id/check`, and reads the {@link McpServer} it returns to persist the row and
 * emit `mcp.status` (§2.5).
 *
 * A server's tools are namespaced `mcp_<server>_<tool>` (§2.2) so two servers with a `search` tool
 * do not collide, and so `DELETE /mcp-servers/:id` can find exactly this server's tools to drop —
 * which is what turns an agent's now-dangling `tools.enabled` entry into `tool_not_registered`
 * (§2.4). Permissions are mapped conservatively: `network: true` always (an MCP tool reaches out of
 * process), `destructive: false` unless the server annotates the tool `destructiveHint` (§2.2).
 */

export const MCP_TOOL_TIMEOUT_MS = 30_000;

/** `mcp_<server>_<tool>`, every segment reduced to snake_case so the name satisfies the contract. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp_${slug(serverName)}_${slug(toolName)}`;
}

function slug(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base.length > 0 ? base : 'x';
}

/** Builds the registry definition for one advertised MCP tool. */
export function toToolDefinition(serverId: string, serverName: string, info: McpToolInfo): ToolDefinition {
  return {
    name: mcpToolName(serverName, info.name),
    description: info.description,
    inputSchema: info.inputSchema,
    outputSchema: info.outputSchema ?? { type: 'object' },
    permissions: {
      network: true,
      fsPaths: [],
      destructive: info.annotations?.destructiveHint === true,
    },
    timeoutMs: MCP_TOOL_TIMEOUT_MS,
    source: 'mcp',
    mcpServerId: serverId,
  };
}

interface Connection {
  server: McpServer;
  client?: McpClient;
  /** The prefixed names this server put in the registry, so they can be dropped together. */
  toolNames: string[];
}

export interface McpManagerOptions {
  readonly registry: ToolRegistry;
  readonly now?: () => string;
}

export class McpManager {
  private readonly registry: ToolRegistry;
  private readonly now: () => string;
  private readonly connections = new Map<string, Connection>();

  constructor(options: McpManagerOptions) {
    this.registry = options.registry;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Connects a server, registers its tools, and returns its row. A connection that fails is not an
   * exception the caller must catch — it comes back `unreachable` with `error` set, contributing no
   * tools, which is exactly the row `POST /mcp-servers` should persist and show (FR-TOOL-007).
   */
  async register(id: string, request: CreateMcpServerRequest): Promise<McpServer> {
    let client: McpClient;
    try {
      client = await McpClient.connect({
        transport: request.transport,
        command: request.command,
        args: request.args,
        url: request.url,
      });
    } catch (error) {
      const server = this.baseServer(id, request, 'unreachable', 0, errorMessage(error));
      this.connections.set(id, { server, toolNames: [] });
      return server;
    }

    let toolNames: string[];
    try {
      toolNames = this.installTools(id, request.name, await client.listTools(), client);
    } catch (error) {
      await client.close();
      const server = this.baseServer(id, request, 'unreachable', 0, errorMessage(error));
      this.connections.set(id, { server, toolNames: [] });
      return server;
    }

    const server = this.baseServer(id, request, 'connected', toolNames.length, undefined);
    this.connections.set(id, { server, client, toolNames });
    return server;
  }

  private installTools(id: string, serverName: string, tools: McpToolInfo[], client: McpClient): string[] {
    const registered: string[] = [];
    for (const info of tools) {
      if (info.name.length === 0) continue;
      const definition = toToolDefinition(id, serverName, info);
      if (this.registry.has(definition.name)) continue; // First registration wins (§2.2).
      this.registry.register(definition, this.callImplementation(client, info.name, definition.name));
      registered.push(definition.name);
    }
    return registered;
  }

  private callImplementation(client: McpClient, originalName: string, toolName: string): ToolImplementation {
    return async (args) => {
      const result = await client.callTool(originalName, args);
      if (result.isError) {
        throw new ToolError('failed', toolName, `The MCP tool reported an error: ${result.text}`, {});
      }
      return { text: result.text };
    };
  }

  /** Drops a server's tools from the registry and closes it. Returns the tool names removed. */
  async deregister(id: string): Promise<string[]> {
    const connection = this.connections.get(id);
    if (connection === undefined) return [];
    const removed = this.registry.unregisterServer(id);
    this.connections.delete(id);
    if (connection.client) await connection.client.close();
    return removed;
  }

  /** Health-checks a connected server and updates its row (`POST /mcp-servers/:id/check`). */
  async check(id: string): Promise<McpServer | undefined> {
    const connection = this.connections.get(id);
    if (connection === undefined) return undefined;

    const alive = connection.client ? await connection.client.ping() : false;
    const status: McpServerStatus = alive ? 'connected' : 'unreachable';
    const server: McpServer = {
      ...connection.server,
      status,
      toolCount: alive ? connection.toolNames.length : 0,
      lastCheckedAt: this.now(),
      error: alive ? undefined : (connection.server.error ?? 'The MCP server did not answer the health check.'),
    };
    connection.server = server;
    return server;
  }

  get(id: string): McpServer | undefined {
    return this.connections.get(id)?.server;
  }

  list(): McpServer[] {
    return [...this.connections.values()].map((connection) => connection.server);
  }

  /** Closes every connection. For engine shutdown. */
  async closeAll(): Promise<void> {
    for (const connection of this.connections.values()) {
      if (connection.client) await connection.client.close();
    }
    this.connections.clear();
  }

  private baseServer(
    id: string,
    request: CreateMcpServerRequest,
    status: McpServerStatus,
    toolCount: number,
    error: string | undefined,
  ): McpServer {
    return {
      id,
      name: request.name,
      transport: request.transport,
      command: request.command,
      args: request.args,
      url: request.url,
      status,
      toolCount,
      lastCheckedAt: this.now(),
      error,
    };
  }
}

function errorMessage(error: unknown): string {
  if (isToolError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}
