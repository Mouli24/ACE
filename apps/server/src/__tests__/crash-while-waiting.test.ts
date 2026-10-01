import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  ApiErrorSchema,
  NodeRunSchema,
  ProjectSchema,
  ProviderSchema,
  RunSchema,
  WorkflowGraphResponseSchema,
  type ApprovalRequest,
  type WorkflowExport,
} from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * D-061 — crash recovery must not leave an approval card that can bring a stopped node back
 * (FR-SYS-009, TC-SYS-010, FR-GRD-013, D111, D120).
 *
 * The engine dies — killed, no shutdown — while a destructive tool call waits for its approval
 * (`destructive.json`, round 4 §2.2). On the next start `recoverAfterCrash` halts the run `crash` and
 * STOPs the waiting node. Nobody can answer that approval any more: the process that was suspended
 * on it is gone. So recovery rejects it, a later Approve or Reject is D120's 404, the node stays
 * STOPPED — and the file the tool would have deleted is still there.
 *
 * The first engine is a real `ace-engine` process (the way `main.test.ts` starts one) so that it can
 * be killed; the restart is in-process over the same data dir.
 */

type SpawnedEngine = ChildProcessByStdio<null, Readable, Readable>;

const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const FIXTURE = new URL('../../../../tests/acceptance/fixtures/round-4/destructive.json', import.meta.url);
const R4_PROVIDER = '01M4R4PV0000000000000000PV';
/** Not used by any other test in this package (main 47597–47599, cli 47592–47596). */
const CRASH_PORT = '47595';

let dir: string;
let child: SpawnedEngine | undefined;
let restarted: RunningEngine | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-d061-'));
});

afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await restarted?.stop();
  restarted = undefined;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
  }
});

/** Start `ace-engine` as a process on `dir` and read its URL and token off the §2.10 line. */
function startProcess(): Promise<{ url: string; token: string; proc: SpawnedEngine }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', MAIN], {
    cwd: REPO_ROOT,
    env: { ...process.env, ACE_DATA_DIR: dir, ACE_PORT: CRASH_PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(
      () => reject(new Error(`engine did not start.\nstdout: ${out}\nstderr: ${err}`)),
      45_000,
    );
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n').find((candidate) => candidate.startsWith('ACE engine ready'));
      if (line === undefined) return;
      clearTimeout(timer);
      const url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1] ?? '';
      const token = line.trim().split('token=')[1] ?? '';
      resolve({ url, token, proc });
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`engine exited before it was ready.\nstdout: ${out}\nstderr: ${err}`));
    });
  });
}

function client(url: string, token: string) {
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${url}/api/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await api(path, { method: 'POST', body: JSON.stringify(body) });
    expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
    return response.json();
  };
  return { api, post };
}

describe('FR-SYS-009 FR-GRD-013 D-061 a crash while a destructive tool waits for its approval', () => {
  it('recovery rejects the approval: a later Approve is 404, the node stays STOPPED, the file survives', async () => {
    /* 1. A real engine process, a destructive run, and the node WAITING on its approval card. */
    const first = await startProcess();
    const before = client(first.url, first.token);

    const provider = ProviderSchema.parse(
      await before.post('/providers', { type: 'mock', name: 'Mock' }),
    );
    await before.post(`/providers/${provider.id}/refresh-models`, {});
    const project = ProjectSchema.parse(await before.post('/projects', { name: 'D-061' }));
    const graph = WorkflowGraphResponseSchema.parse(
      await before.post(
        `/projects/${project.id}/workflows/import`,
        JSON.parse(readFileSync(FIXTURE, 'utf8').replaceAll(R4_PROVIDER, provider.id)) as WorkflowExport,
      ),
    );

    const run = RunSchema.parse(await before.post(`/workflows/${graph.workflow.id}/runs`, {}));
    let request: ApprovalRequest | undefined;
    for (let i = 0; i < 200 && request === undefined; i++) {
      const [pending] = (await (await before.api(`/runs/${run.id}/approvals`)).json()) as
        | ApprovalRequest[];
      const row =
        pending === undefined
          ? undefined
          : NodeRunSchema.parse(await (await before.api(`/node-runs/${pending.nodeRunId}`)).json());
      if (row?.status === 'WAITING') request = pending;
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (request === undefined) throw new Error('no node went WAITING on an approval');
    expect(request).toMatchObject({ point: 'tool', checkType: 'destructive_action' });

    // The file `mock-destructive` asks to delete, in the run's sandbox (round 4 §2.2).
    const sandbox = join(dir, 'sandbox', run.id);
    mkdirSync(sandbox, { recursive: true });
    const notes = join(sandbox, 'notes.txt');
    writeFileSync(notes, 'stale notes');

    /* 2. The engine dies: no shutdown, no halt, nothing written on the way out. */
    const exited = new Promise<void>((resolve) => first.proc.on('exit', () => resolve()));
    first.proc.kill('SIGKILL');
    await exited;
    child = undefined;

    /* 3. It starts again over the same data dir; recovery runs before the first request. */
    restarted = await startEngine({ dataDir: dir, port: 0, env: {} });
    const after = client(restarted.url, restarted.token);

    expect(RunSchema.parse(await (await after.api(`/runs/${run.id}`)).json())).toMatchObject({
      status: 'HALTED',
      haltReason: 'crash',
    });
    // No card is left on a dead run: nothing is pending, so nothing can be decided (D120).
    expect((await (await after.api(`/runs/${run.id}/approvals`)).json()) as unknown[]).toEqual([]);

    for (const kind of ['approve', 'reject'] as const) {
      const late = await after.api(`/node-runs/${request.nodeRunId}/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ note: 'after the restart' }),
      });
      expect(late.status, `${kind} after the restart`).toBe(404);
      expect(ApiErrorSchema.parse(await late.json()).error.code).toBe('not_found');
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    const node = NodeRunSchema.parse(await (await after.api(`/node-runs/${request.nodeRunId}`)).json());
    expect(node.status).toBe('STOPPED');
    expect(node.approvals?.map((decision) => decision.decision)).toEqual(['reject']);
    expect(node.toolCalls.filter((call) => call.status === 'ok')).toEqual([]);
    expect(existsSync(notes)).toBe(true);
    expect(RunSchema.parse(await (await after.api(`/runs/${run.id}`)).json()).status).toBe('HALTED');
  }, 90_000);
});
