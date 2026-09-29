import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApiErrorSchema,
  GuardrailPolicySchema,
  NodeRunSchema,
  ProjectSchema,
  ProviderSchema,
  RunSchema,
  WorkflowGraphResponseSchema,
  type ApprovalRequest,
  type Run,
  type WorkflowExport,
} from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * D-054 over the real server (FR-CTL-003, FR-GRD-013, D111, D120): a Stop while a node is WAITING on
 * an approval ends the run, and a later Approve cannot bring the node back.
 *
 * The engine's own tests (`packages/engine/src/__tests__/stop-while-waiting.test.ts`) prove the
 * scheduler, the controls and the approval service on a scripted model. What this adds is the
 * wiring in `server.ts` — the `onWaiting`/`onDecided` hooks that write the WAITING and RUNNING rows,
 * the approval service handed to the controls — with the real mock provider, the real round-3/4
 * fixtures and the real `sandbox_delete` on a real file.
 */

const R3_PROVIDER = '01M3R3PV0000000000000000PV';
const R3_POLICY = '01M3R3PC0000000000000000PC';
const R4_PROVIDER = '01M4R4PV0000000000000000PV';
const fixtures = new URL('../../../../tests/acceptance/fixtures/', import.meta.url);

let dir: string;
let engine: RunningEngine;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ace-d054-'));
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

async function mockProvider(): Promise<string> {
  const provider = ProviderSchema.parse(await post('/providers', { type: 'mock', name: 'Mock' }));
  await post(`/providers/${provider.id}/refresh-models`, {});
  return provider.id;
}

async function importFixture(file: string, rewrites: Record<string, string>): Promise<string> {
  const project = ProjectSchema.parse(await post('/projects', { name: 'D-054' }));
  let text = readFileSync(new URL(file, fixtures), 'utf8');
  for (const [from, to] of Object.entries(rewrites)) text = text.replaceAll(from, to);
  const imported = WorkflowGraphResponseSchema.parse(
    await post(`/projects/${project.id}/workflows/import`, JSON.parse(text) as WorkflowExport),
  );
  return imported.workflow.id;
}

/** Polls until a node run is WAITING on an approval — bounded, so a missing card fails fast. */
async function waitingApproval(runId: string): Promise<ApprovalRequest> {
  for (let i = 0; i < 200; i++) {
    const [pending] = (await (await api(`/runs/${runId}/approvals`)).json()) as ApprovalRequest[];
    if (pending !== undefined) {
      const row = NodeRunSchema.parse(await (await api(`/node-runs/${pending.nodeRunId}`)).json());
      if (row.status === 'WAITING') return pending;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no node went WAITING on an approval');
}

/** Polls the run row until it has ended — bounded at two seconds, FR-CTL-003's budget. */
async function endedWithin2s(runId: string): Promise<Run> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const run = RunSchema.parse(await (await api(`/runs/${runId}`)).json());
    if (!['PREFLIGHT', 'RUNNING', 'PAUSED'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run still ${run.status} two seconds after the stop`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopThenApprove(runId: string, request: ApprovalRequest): Promise<void> {
  const stopped = RunSchema.parse(await post(`/runs/${runId}/stop`, {}));
  expect(stopped).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
  expect(await endedWithin2s(runId)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });

  // The stop took the card away (D111): nothing is left to decide, so a late Approve is D120's 404.
  expect((await (await api(`/runs/${runId}/approvals`)).json()) as unknown[]).toEqual([]);
  const late = await api(`/node-runs/${request.nodeRunId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ note: 'too late' }),
  });
  expect(late.status).toBe(404);
  expect(ApiErrorSchema.parse(await late.json()).error.code).toBe('not_found');

  // Give any late write the chance to land, then read the rows: still STOPPED inside HALTED.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const node = NodeRunSchema.parse(await (await api(`/node-runs/${request.nodeRunId}`)).json());
  expect(node.status).toBe('STOPPED');
  expect(node.approvals?.map((decision) => decision.decision)).toEqual(['reject']);
  expect(RunSchema.parse(await (await api(`/runs/${runId}`)).json())).toMatchObject({
    status: 'HALTED',
    haltReason: 'stopped',
  });
}

describe('FR-CTL-003 FR-GRD-013 D-054 Stop while WAITING, over the real server', () => {
  it('an output-point ask_user approval (pii-ask.json): the run halts and a late Approve is 404', async () => {
    const providerId = await mockProvider();
    const holder = ProjectSchema.parse(await post('/projects', { name: 'policy holder' }));
    const sidecar = JSON.parse(
      readFileSync(new URL('round-3/pii-ask.policy.json', fixtures), 'utf8'),
    ) as Record<string, unknown>;
    const policy = GuardrailPolicySchema.parse(
      await post('/guardrail-policies', { ...sidecar, projectId: holder.id }),
    );
    const workflowId = await importFixture('round-3/pii-ask.json', {
      [R3_PROVIDER]: providerId,
      [R3_POLICY]: policy.id,
    });

    const run = RunSchema.parse(await post(`/workflows/${workflowId}/runs`, {}));
    const request = await waitingApproval(run.id);
    expect(request.point).toBe('output');

    await stopThenApprove(run.id, request);
  }, 30_000);

  it('a destructive tool approval (destructive.json): the run halts and the file is never deleted', async () => {
    const providerId = await mockProvider();
    const workflowId = await importFixture('round-4/destructive.json', { [R4_PROVIDER]: providerId });

    const run = RunSchema.parse(await post(`/workflows/${workflowId}/runs`, {}));
    const request = await waitingApproval(run.id);
    expect(request).toMatchObject({ point: 'tool', checkType: 'destructive_action' });

    // The file `mock-destructive` asks to delete, in the run's own sandbox (round 4 §2.2).
    const sandbox = join(dir, 'sandbox', run.id);
    mkdirSync(sandbox, { recursive: true });
    const notes = join(sandbox, 'notes.txt');
    writeFileSync(notes, 'stale notes');

    await stopThenApprove(run.id, request);

    expect(existsSync(notes)).toBe(true);
    const node = NodeRunSchema.parse(await (await api(`/node-runs/${request.nodeRunId}`)).json());
    expect(node.toolCalls.filter((call) => call.status === 'ok')).toEqual([]);
  }, 30_000);
});
