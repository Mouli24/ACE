import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NodeRunSchema,
  ProjectSchema,
  ProviderSchema,
  RunSchema,
  WorkflowGraphResponseSchema,
  type ApprovalRequest,
  type WorkflowExport,
} from '@ace/contracts';
import { createMockAdapter, type MockProviderAdapter } from '@ace/providers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * D379 (agentic nodes): a Stop ends the run's agent session, so a background command the run
 * started does not outlive it. Stop emits `run.completed`, and the server ends the session on that
 * event; this proves the whole path with a real process and a real pid.
 */

const R4_PROVIDER = '01M4R4PV0000000000000000PV';
const fixtures = new URL('../../../../tests/acceptance/fixtures/', import.meta.url);

let dir: string;
let folder: string;
let engine: RunningEngine;

const COMMAND = `node -e "require('fs').writeFileSync('bg.pid',String(process.pid));setInterval(()=>{},1000)"`;

/** The mock, except `mock-destructive` starts a background command, then waits to be stopped. */
function backgroundCommandMock(): MockProviderAdapter {
  const base = createMockAdapter();
  const generate: MockProviderAdapter['generate'] = (req, signal) => {
    if (req.modelId !== 'mock-destructive') return base.generate(req, signal);
    return (async function* () {
      if ((req.toolResults ?? []).length === 0) {
        yield {
          type: 'tool_call' as const,
          callId: 'call-bg',
          name: 'run_command',
          args: { command: COMMAND, background: true },
        };
        yield { type: 'usage' as const, tokensIn: 1, tokensOut: 0 };
        yield { type: 'finish' as const, reason: 'tool_calls' as const };
        return;
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'text' as const, delta: 'stopped' };
      yield { type: 'finish' as const, reason: 'stop' as const };
    })();
  };
  return {
    ...base,
    generate,
    forProvider: (row) => ({ ...base.forProvider(row), generate }),
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ace-d379-'));
  folder = mkdtempSync(join(tmpdir(), 'ace-d379-project-'));
  engine = await startEngine({
    dataDir: dir,
    port: 0,
    env: {},
    mockProvider: backgroundCommandMock(),
  });
});

afterEach(async () => {
  await engine.stop();
  for (const path of [dir, folder]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Windows can hold a handle for a moment; the OS reclaims temp itself.
    }
  }
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${engine.url}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${engine.token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await api(path, { method: 'POST', body: JSON.stringify(body) });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return response.json();
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until<T>(
  what: string,
  read: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('D379 Stop kills the commands the run started', () => {
  it('a background command is gone once the run is stopped', async () => {
    const provider = ProviderSchema.parse(await post('/providers', { type: 'mock', name: 'Mock' }));
    await post(`/providers/${provider.id}/refresh-models`, {});
    const project = ProjectSchema.parse(
      await post('/projects', { name: 'D-379', folderPath: folder }),
    );
    const text = readFileSync(new URL('round-4/destructive.json', fixtures), 'utf8')
      .replaceAll(R4_PROVIDER, provider.id)
      .replace('"sandbox_delete"', '"run_command"');
    const imported = WorkflowGraphResponseSchema.parse(
      await post(`/projects/${project.id}/workflows/import`, JSON.parse(text) as WorkflowExport),
    );
    const run = RunSchema.parse(await post(`/workflows/${imported.workflow.id}/runs`, {}));

    // run_command is destructive: it asks first. Approve it so the background command starts.
    const request = await until('the approval', async () => {
      const [pending] = (await (
        await api(`/runs/${run.id}/approvals`)
      ).json()) as ApprovalRequest[];
      return pending;
    });
    await post(`/node-runs/${request.nodeRunId}/approve`, {});

    const pidFile = join(folder, 'bg.pid');
    const pid = Number(
      await until('the pid file', () =>
        existsSync(pidFile) ? readFileSync(pidFile, 'utf8') || undefined : undefined,
      ),
    );
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(alive(pid)).toBe(true);

    await post(`/runs/${run.id}/stop`, {});

    await until('the command to die', () => (alive(pid) ? undefined : true));
    const node = NodeRunSchema.parse(await (await api(`/node-runs/${request.nodeRunId}`)).json());
    expect(node.status).toBe('STOPPED');
  }, 40_000);
});
