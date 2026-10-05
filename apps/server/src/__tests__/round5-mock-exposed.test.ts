import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockAdapter } from '@ace/providers';
import { afterEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';
import {
  PLACEHOLDER,
  createProject,
  fixtureWorkflow,
  importWorkflow,
  mockProvider,
  runToEnd,
  type Round5Engine,
} from './round5-harness.js';

/**
 * TC-RAG-009 / FR-RAG-010: the acceptance harness counts summarisation calls on
 * `RunningEngine.mockProvider.calls()`, so the engine exposes the mock adapter its `mock` provider
 * rows share — the injected one when given, otherwise the one it made.
 */

const started: { engine: RunningEngine; dir: string }[] = [];

async function start(mock?: ReturnType<typeof createMockAdapter>) {
  const dir = mkdtempSync(join(tmpdir(), 'ace-r5-mock-'));
  const engine = await startEngine({
    dataDir: dir,
    port: 0,
    env: {},
    ...(mock === undefined ? {} : { mockProvider: mock }),
  });
  started.push({ engine, dir });
  return { engine, dir };
}

afterEach(async () => {
  for (const { engine, dir } of started.splice(0)) {
    await engine.stop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
    }
  }
});

/** Just enough of the harness's `Round5Engine` for its run helpers. */
function asHarness(engine: RunningEngine, dir: string): Round5Engine {
  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${engine.url}/api/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${engine.token}`, ...init.headers },
    });
  const ok = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await api(path, init);
    const text = await response.text();
    expect(response.status, `${path}: ${text}`).toBeLessThan(300);
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  };
  return {
    engine,
    dir,
    mock: engine.mockProvider,
    api,
    ok,
    get: (path) => ok(path),
    post: (path, body = {}) =>
      ok(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
    stop: () => engine.stop(),
  };
}

describe('TC-RAG-009 the running engine exposes its mock adapter', () => {
  it('with no option it exposes the adapter its mock rows use, and a run lands in calls()', async () => {
    const { engine, dir } = await start();
    expect(engine.mockProvider).toBeDefined();
    expect(engine.mockProvider.calls()).toHaveLength(0);

    const e = asHarness(engine, dir);
    const providerId = await mockProvider(e);
    const projectId = await createProject(e, 'Exposed');
    const graph = await importWorkflow(
      e,
      projectId,
      fixtureWorkflow('summary.json', { [PLACEHOLDER.provider]: providerId }),
    );
    expect((await runToEnd(e, graph.workflow.id)).status).toBe('COMPLETE');

    expect(engine.mockProvider.calls().length).toBeGreaterThan(0);
  }, 60_000);

  it('an injected adapter is the one exposed', async () => {
    const mock = createMockAdapter();
    const { engine } = await start(mock);
    expect(engine.mockProvider).toBe(mock);
  }, 60_000);
});
