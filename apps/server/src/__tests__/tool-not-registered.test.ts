import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  McpServerSchema,
  ProjectSchema,
  ProviderSchema,
  RunSchema,
  ToolListResponseSchema,
  ValidationIssueSchema,
  WorkflowGraphResponseSchema,
  type WorkflowExport,
} from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * Round 4 §2.4 over the real server (D-069): once an MCP server is removed, an agent that still
 * enables one of its tools is `tool_not_registered` — the registry the gateway validates against is
 * the live one the MCP manager registers into and `DELETE /mcp-servers/:id` drops from.
 */

const fixturesDir = new URL('../../../../tests/acceptance/fixtures/round-4/', import.meta.url);
const MCP_SERVER_SCRIPT = fileURLToPath(new URL('servers/mcp-server.mjs', fixturesDir));

let dir: string;
let engine: RunningEngine;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ace-tools-'));
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

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${engine.url}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${engine.token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await api(path, { method: 'POST', body: JSON.stringify(body) });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return response.json();
}

describe('§2.4 tool_not_registered from POST /workflows/:id/validate (D-069)', () => {
  it('a removed MCP server leaves the agent that enabled its tool with an error naming it', async () => {
    const server = McpServerSchema.parse(
      await post('/mcp-servers', {
        name: 'goners',
        transport: 'stdio',
        command: process.execPath,
        args: [MCP_SERVER_SCRIPT],
      }),
    );
    expect(server.status).toBe('connected');

    const provider = ProviderSchema.parse(await post('/providers', { type: 'mock', name: 'Mock' }));
    await post(`/providers/${provider.id}/refresh-models`, {});
    const project = ProjectSchema.parse(await post('/projects', { name: 'MCP' }));
    const text = readFileSync(new URL('mcp.json', fixturesDir), 'utf8')
      .replaceAll('01M4R4PV0000000000000000PV', provider.id)
      .replaceAll('__ACE_MCP_TOOL__', 'mcp_goners_ping');
    const graph = WorkflowGraphResponseSchema.parse(
      await post(`/projects/${project.id}/workflows/import`, JSON.parse(text) as WorkflowExport),
    );
    const connector = graph.nodes.find((node) => node.kind === 'agent');

    const validate = async () =>
      ValidationIssueSchema.array().parse(
        ((await post(`/workflows/${graph.workflow.id}/validate`, {})) as { issues: unknown })
          .issues,
      );

    // While the server is there, its tool is registered: no tool issue.
    expect((await validate()).map((issue) => issue.code)).not.toContain('tool_not_registered');

    expect((await api(`/mcp-servers/${server.id}`, { method: 'DELETE' })).status).toBe(204);
    const tools = ToolListResponseSchema.parse(await (await api('/tools')).json());
    expect(tools.items.map((tool) => tool.name)).not.toContain('mcp_goners_ping');

    const issues = await validate();
    const issue = issues.find((candidate) => candidate.code === 'tool_not_registered');
    expect(issue).toMatchObject({ severity: 'error', nodeId: connector?.id });
    expect(issue?.message).toContain('mcp_goners_ping');

    // BR-08: pre-flight refuses the run itself, before a single node runs.
    const run = RunSchema.parse(await post(`/workflows/${graph.workflow.id}/runs`, {}));
    expect(run.status).toBe('BLOCKED');
    expect(run.preflightIssues).toContainEqual(
      expect.objectContaining({ code: 'tool_not_registered', nodeId: connector?.id }),
    );
    const nodeRuns = (await (await api(`/runs/${run.id}/node-runs`)).json()) as unknown[];
    expect(nodeRuns).toEqual([]);
  }, 30_000);
});
