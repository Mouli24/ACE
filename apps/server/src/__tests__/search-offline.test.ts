import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NodeRunSchema,
  ProjectSchema,
  ProviderSchema,
  RunSchema,
  WorkflowGraphResponseSchema,
  type Run,
  type WorkflowExport,
} from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * TC-TOOL-003 / TC-TOOL-006 over the real server (D14, D-067): `search.json` — `mock-search` runs
 * `web_search`, then `web_fetch` on the first result, then answers — completes with exactly two `ok`
 * calls, no SearXNG and no network. The canned search index's result URLs are pointed at a local page
 * server with `startEngine({ cannedSearchBaseUrl })`; the fixture allows that host (127.0.0.1), so
 * `domain_allowlist` is exactly what it always was. Without the option the results sit under the
 * reserved `https://example.test` and the allow-list refuses the fetch, as it must.
 */

const fixturesDir = new URL('../../../../tests/acceptance/fixtures/round-4/', import.meta.url);

let dir: string;
let engine: RunningEngine | undefined;
let pages: Server;
let pagesUrl: string;
let pageHits: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ace-search-'));
  pageHits = [];
  pages = createServer((request, response) => {
    pageHits.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<html><head><title>Quarterly page</title></head><body><p>Numbers.</p></body></html>',
    );
  });
  await new Promise<void>((resolve) => pages.listen(0, '127.0.0.1', resolve));
  pagesUrl = `http://127.0.0.1:${(pages.address() as { port: number }).port}`;
});

afterEach(async () => {
  await engine?.stop();
  engine = undefined;
  await new Promise<void>((resolve) => pages.close(() => resolve()));
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
  }
});

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const running = engine as RunningEngine;
  const response = await fetch(`${running.url}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${running.token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return response.json();
}

const post = (path: string, body: unknown): Promise<unknown> =>
  api(path, { method: 'POST', body: JSON.stringify(body) });

async function runSearchFixture(): Promise<{
  run: Run;
  calls: { toolName: string; status: string; args: unknown }[];
}> {
  const provider = ProviderSchema.parse(await post('/providers', { type: 'mock', name: 'Mock' }));
  await post(`/providers/${provider.id}/refresh-models`, {});
  const project = ProjectSchema.parse(await post('/projects', { name: 'Search offline' }));
  const text = readFileSync(new URL('search.json', fixturesDir), 'utf8').replaceAll(
    '01M4R4PV0000000000000000PV',
    provider.id,
  );
  const graph = WorkflowGraphResponseSchema.parse(
    await post(`/projects/${project.id}/workflows/import`, JSON.parse(text) as WorkflowExport),
  );

  let run = RunSchema.parse(await post(`/workflows/${graph.workflow.id}/runs`, {}));
  for (let i = 0; i < 300 && ['PREFLIGHT', 'RUNNING'].includes(run.status); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = RunSchema.parse(await api(`/runs/${run.id}`));
  }
  const nodeRuns = NodeRunSchema.array().parse(await api(`/runs/${run.id}/node-runs`));
  return { run, calls: nodeRuns.flatMap((nodeRun) => nodeRun.toolCalls) };
}

describe('TC-TOOL-003 search → fetch → answer offline (D-067)', () => {
  it('with the canned index on a local page server: two ok calls, the fetch reached it, run COMPLETE', async () => {
    engine = await startEngine({ dataDir: dir, port: 0, env: {}, cannedSearchBaseUrl: pagesUrl });

    const { run, calls } = await runSearchFixture();

    expect(calls.map((call) => [call.toolName, call.status])).toEqual([
      ['web_search', 'ok'],
      ['web_fetch', 'ok'],
    ]);
    // The fetch was given the first canned result, and that request is the one the page server saw.
    const fetched = String((calls[1]?.args as { url?: unknown }).url);
    expect(fetched.startsWith(`${pagesUrl}/`)).toBe(true);
    expect(fetched.endsWith('/1')).toBe(true);
    expect(pageHits).toEqual([fetched.slice(pagesUrl.length)]);
    expect(run.status).toBe('COMPLETE');
  });

  it('without it the results stay under example.test, which the allow-list refuses before any fetch', async () => {
    engine = await startEngine({ dataDir: dir, port: 0, env: {} });

    const { run, calls } = await runSearchFixture();

    expect(calls.map((call) => [call.toolName, call.status])).toEqual([
      ['web_search', 'ok'],
      ['web_fetch', 'blocked'],
    ]);
    expect(String((calls[1]?.args as { url?: unknown }).url)).toMatch(/^https:\/\/example\.test\//);
    expect(pageHits).toEqual([]);
    expect(run.status).toBe('HALTED');
  });
});
