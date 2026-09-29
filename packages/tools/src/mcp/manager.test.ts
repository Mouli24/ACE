import { afterEach, describe, expect, it } from 'vitest';

import { ToolRegistry } from '../registry.js';
import { makeContext, startHttpServer, writeStdioMcpFixture, TEST_MCP_SERVER_ID } from '../__tests__/helpers.js';
import { McpManager, mcpToolName } from './manager.js';

const NOW = '2026-09-29T00:00:00.000Z';

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
  cleanups = [];
});

function newManager(): { manager: McpManager; registry: ToolRegistry } {
  const registry = new ToolRegistry();
  return { manager: new McpManager({ registry, now: () => NOW }), registry };
}

describe('mcpToolName', () => {
  it('namespaces server and tool into snake_case', () => {
    expect(mcpToolName('Test Server', 'Read File')).toBe('mcp_test_server_read_file');
  });
});

describe('TC-TOOL-008 MCP over stdio', () => {
  it('connects, registers its tools prefixed, and calls one', async () => {
    const fixture = writeStdioMcpFixture();
    cleanups.push(fixture.cleanup);
    const { manager, registry } = newManager();
    cleanups.push(() => manager.closeAll());

    const server = await manager.register(TEST_MCP_SERVER_ID, {
      name: 'Test Server',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture.path],
    });

    expect(server.status).toBe('connected');
    expect(server.toolCount).toBe(2);
    expect(registry.list().map((tool) => tool.name)).toEqual(['mcp_test_server_reverse', 'mcp_test_server_wipe']);

    const wipe = registry.get('mcp_test_server_wipe');
    expect(wipe?.definition.permissions).toEqual({ network: true, fsPaths: [], destructive: true });
    expect(registry.get('mcp_test_server_reverse')?.definition.permissions.destructive).toBe(false);

    const reverse = registry.get('mcp_test_server_reverse');
    const result = await reverse?.implementation({ text: 'abc' }, makeContext());
    expect(result).toEqual({ text: 'cba' });
  });

  it('drops the server tools on deregister and reports them gone', async () => {
    const fixture = writeStdioMcpFixture();
    cleanups.push(fixture.cleanup);
    const { manager, registry } = newManager();

    await manager.register(TEST_MCP_SERVER_ID, {
      name: 'Test Server',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture.path],
    });
    const removed = await manager.deregister(TEST_MCP_SERVER_ID);

    expect(removed).toEqual(['mcp_test_server_reverse', 'mcp_test_server_wipe']);
    expect(registry.list()).toHaveLength(0);
    expect(manager.get(TEST_MCP_SERVER_ID)).toBeUndefined();
  });

  it('health-checks a connected server', async () => {
    const fixture = writeStdioMcpFixture();
    cleanups.push(fixture.cleanup);
    const { manager } = newManager();
    cleanups.push(() => manager.closeAll());

    await manager.register(TEST_MCP_SERVER_ID, {
      name: 'Test Server',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture.path],
    });
    const checked = await manager.check(TEST_MCP_SERVER_ID);
    expect(checked?.status).toBe('connected');
    expect(checked?.lastCheckedAt).toBe(NOW);
  });
});

describe('MCP failures come back as unreachable, not as exceptions', () => {
  it('reports a command that will not start', async () => {
    const { manager, registry } = newManager();
    const server = await manager.register(TEST_MCP_SERVER_ID, {
      name: 'Broken',
      transport: 'stdio',
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
    });
    expect(server.status).toBe('unreachable');
    expect(server.error).toBeTruthy();
    expect(server.toolCount).toBe(0);
    expect(registry.list()).toHaveLength(0);
  });

  it('deregistering an unknown server is a no-op', async () => {
    const { manager } = newManager();
    expect(await manager.deregister(TEST_MCP_SERVER_ID)).toEqual([]);
    expect(await manager.check(TEST_MCP_SERVER_ID)).toBeUndefined();
  });
});

describe('an MCP tool that reports an error fails the call', () => {
  it('turns isError into a rejected tool call, and skips a nameless tool', async () => {
    const server = await startHttpServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number; method: string };
        if (msg.id === undefined) {
          res.statusCode = 202;
          res.end();
          return;
        }
        const reply = (result: unknown): void => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: {} });
        else if (msg.method === 'tools/list')
          reply({
            tools: [
              { name: '', description: 'nameless', inputSchema: {} },
              { name: 'explode', description: 'x', inputSchema: { type: 'object' } },
            ],
          });
        else reply({ content: [{ type: 'text', text: 'kaboom' }], isError: true });
      });
    });
    cleanups.push(server.close);
    const { manager, registry } = newManager();
    cleanups.push(() => manager.closeAll());

    const row = await manager.register(TEST_MCP_SERVER_ID, { name: 'Err', transport: 'http', url: server.url });
    expect(row.toolCount).toBe(1); // the nameless tool was skipped
    await expect(registry.get('mcp_err_explode')?.implementation({}, makeContext())).rejects.toMatchObject({
      kind: 'failed',
    });
  });
});

describe('a health check on an unreachable server', () => {
  it('reports unreachable with no client and keeps the prior error', async () => {
    const { manager } = newManager();
    await manager.register(TEST_MCP_SERVER_ID, {
      name: 'Broken',
      transport: 'stdio',
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
    });
    const checked = await manager.check(TEST_MCP_SERVER_ID);
    expect(checked?.status).toBe('unreachable');
    expect(checked?.toolCount).toBe(0);
    expect(checked?.error).toBeTruthy();
  });
});

describe('TC-TOOL-008 MCP over http', () => {
  it('connects to an http JSON-RPC server and lists its tools', async () => {
    const server = await startHttpServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number; method: string };
        if (msg.id === undefined) {
          res.statusCode = 202;
          res.end();
          return;
        }
        const reply = (result: unknown): void => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        };
        if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: {} });
        else if (msg.method === 'tools/list')
          reply({ tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }] });
        else reply({ content: [{ type: 'text', text: 'pong' }] });
      });
    });
    cleanups.push(server.close);
    const { manager, registry } = newManager();
    cleanups.push(() => manager.closeAll());

    const row = await manager.register(TEST_MCP_SERVER_ID, {
      name: 'Http Srv',
      transport: 'http',
      url: server.url,
    });
    expect(row.status).toBe('connected');
    expect(registry.get('mcp_http_srv_ping')).toBeDefined();

    const result = await registry.get('mcp_http_srv_ping')?.implementation({}, makeContext());
    expect(result).toEqual({ text: 'pong' });
  });
});
