import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_SCOPE } from '@ace/engine';
import { CannedSearchBackend } from '@ace/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settingsSearchBackend } from '../search-backend.js';
import { startEngine, type RunningEngine } from '../server.js';

/**
 * [audit U-3] Settings the engine saved and never read (D14, D16, D-084): `searxngUrl` now picks
 * `web_search`'s backend at each search, and `mcpEnabled: false` keeps MCP servers from being added.
 */

describe('[audit U-3] web_search reads settings.searxngUrl at each search', () => {
  let searx: Server;
  let searxUrl: string;
  let asked: string[];

  beforeEach(async () => {
    asked = [];
    // A stand-in SearXNG: its JSON API answers one result for any query.
    searx = createServer((request, response) => {
      asked.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          results: [{ title: 'From SearXNG', url: 'https://found.example/a', content: 'snippet' }],
        }),
      );
    });
    await new Promise<void>((resolve) => searx.listen(0, '127.0.0.1', resolve));
    searxUrl = `http://127.0.0.1:${(searx.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => searx.close(() => resolve()));
  });

  it('asks SearXNG once a URL is set, and the canned index when it is not — no restart between', async () => {
    let configured: string | undefined;
    const backend = settingsSearchBackend(async () => configured, new CannedSearchBackend());

    const canned = await backend.search(LOCAL_SCOPE, 'quarterly numbers', 2);
    expect(canned[0]?.url).toContain('example.test');
    expect(asked).toEqual([]);

    configured = searxUrl;
    const found = await backend.search(LOCAL_SCOPE, 'quarterly numbers', 2);
    expect(found).toEqual([
      { title: 'From SearXNG', url: 'https://found.example/a', snippet: 'snippet' },
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('q=quarterly+numbers');
    expect(asked[0]).toContain('format=json');
  });
});

describe('[audit U-3] D16 MCP off in Settings', () => {
  let dir: string;
  let engine: RunningEngine;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ace-settings-wiring-'));
    engine = await startEngine({ dataDir: dir, port: 0, env: {} });
  });

  afterEach(async () => {
    await engine.stop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
    }
  });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${engine.url}/api/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${engine.token}`, 'content-type': 'application/json' },
    });

  it('refuses to add an MCP server, says why, and connects nothing', async () => {
    const off = await api('/settings', {
      method: 'PATCH',
      body: JSON.stringify({ mcpEnabled: false }),
    });
    expect(off.status).toBe(200);

    const response = await api('/mcp-servers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'fixtures',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('MCP is turned off in Settings');
    const listed = (await (await api('/mcp-servers')).json()) as { items: unknown[] };
    expect(listed.items).toEqual([]);
  });
});
