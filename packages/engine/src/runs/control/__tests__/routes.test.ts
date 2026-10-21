import type { ApiError, NodeRun, Run } from '@ace/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { toApiError } from '../../../gateway/errors.js';
import { createRunGateRegistry } from '../gate.js';
import { createRunControlRoutes } from '../routes.js';
import { createRunControls, type RunControls } from '../service.js';
import {
  agentNode,
  createCapturedBus,
  createFakeStores,
  edge,
  inputNode,
  makeNodeRun,
  makeRun,
  outputNode,
  tickingClock,
  type FakeStores,
} from './harness.js';

/**
 * The §2.5 control endpoints over HTTP.
 *
 * Mounted the way the gateway mounts them — `api.route('/', createRunControlRoutes(...))` — with the
 * gateway's own `onError`, so the 409 a refused control produces is the §2.3 envelope a client
 * actually receives, not an exception escaping into a 500.
 */

const brief = inputNode('Brief');
const writer = agentNode('Writer');
const reviewer = agentNode('Reviewer');
const result = outputNode('Result');
const snapshot = {
  version: 1,
  nodes: [brief, writer, reviewer, result],
  edges: [edge(brief, writer), edge(writer, reviewer), edge(reviewer, result)],
};

let idCounter = 0;
const nextId = (): string => `01JBXQ8Z9KQ4R7N2VWXYZ0H${String(idCounter++).padStart(3, '0')}`;

function app(seed: { runs?: Run[]; nodeRuns?: NodeRun[] }): {
  request: (path: string, body?: unknown) => Promise<Response>;
  stores: FakeStores;
  controls: RunControls;
} {
  const stores = createFakeStores(seed);
  const controls = createRunControls({
    runs: stores.runs,
    nodeRuns: stores.nodeRuns,
    bus: createCapturedBus(),
    gates: createRunGateRegistry(),
    now: tickingClock(),
    nextId,
    driveRecordedRun: async (run) =>
      (await stores.runs.update(run.id, { status: 'RUNNING' })) ?? run,
    drivePartialRun: async (plan) => plan.run,
  });

  const hono = new Hono();
  hono.onError((error, c) => {
    const { status, body } = toApiError(error);
    return c.json(body, status as 400);
  });
  hono.route(
    '/api/v1',
    createRunControlRoutes(() => controls),
  );

  return {
    stores,
    controls,
    request: async (path, body) =>
      hono.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };
}

describe('§2.5 POST /runs/:id/pause · /resume · /stop · /restart', () => {
  it('pauses a running run and answers the Run with `allowedActions`', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const { request } = app({ runs: [run] });

    const response = await request(`/api/v1/runs/${run.id}/pause`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Run;
    expect(body).toMatchObject({
      id: run.id,
      status: 'PAUSED',
      allowedActions: ['resume', 'stop'],
    });
  });

  it('resumes a paused run', async () => {
    const run = makeRun({ snapshot, status: 'PAUSED' });
    const { request } = app({ runs: [run] });

    const body = (await (await request(`/api/v1/runs/${run.id}/resume`)).json()) as Run;
    expect(body.status).toBe('RUNNING');
  });

  it('stops a running run and halts it `stopped`', async () => {
    const run = makeRun({ snapshot, status: 'RUNNING' });
    const { request } = app({ runs: [run] });

    const body = (await (await request(`/api/v1/runs/${run.id}/stop`)).json()) as Run;
    expect(body).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
  });

  it('answers a restart with 201 and the NEW run, carrying `restartedFromRunId` (§2.5)', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const { request } = app({ runs: [run] });

    const response = await request(`/api/v1/runs/${run.id}/restart`);
    expect(response.status).toBe(201);

    const body = (await response.json()) as Run;
    expect(body.id).not.toBe(run.id);
    expect(body.restartedFromRunId).toBe(run.id);
  });

  it('refuses an action the run’s state does not allow with 409 `invalid_run_state`', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const { request } = app({ runs: [run] });

    const response = await request(`/api/v1/runs/${run.id}/pause`);
    expect(response.status).toBe(409);

    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe('invalid_run_state');
    expect(body.error.details).toMatchObject({ status: 'HALTED', allowedActions: ['restart'] });
  });

  it('answers 404 for a run that does not exist', async () => {
    const { request } = app({ runs: [] });
    const response = await request('/api/v1/runs/01JBXQ8Z9KQ4R7N2VWXYZ0NONE/stop');
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiError).error.code).toBe('not_found');
  });
});

describe('§2.5 POST /node-runs/:id/retry and /runs/:id/nodes/:nodeId/rerun', () => {
  it('a retry answers 201 with the new attempt', async () => {
    const run = makeRun({ snapshot, status: 'HALTED', haltReason: 'failure' });
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED', attempt: 1 });
    const { request } = app({ runs: [run], nodeRuns: [failed] });

    const response = await request(`/api/v1/node-runs/${failed.id}/retry`, {
      withDownstream: false,
    });
    expect(response.status).toBe(201);

    const body = (await response.json()) as NodeRun;
    expect(body).toMatchObject({ nodeId: writer.id, attempt: 2, status: 'READY' });
  });

  it('refuses a retry body without `withDownstream` (RetryRequest is required, §2.1)', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED' });
    const { request } = app({ runs: [run], nodeRuns: [failed] });

    const response = await request(`/api/v1/node-runs/${failed.id}/retry`, {});
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error.code).toBe('validation_failed');
  });

  it('treats a malformed retry body as an empty one, and so refuses it', async () => {
    const run = makeRun({ snapshot, status: 'HALTED' });
    const failed = makeNodeRun(run, writer.id, { status: 'FAILED' });
    const { request } = app({ runs: [run], nodeRuns: [failed] });

    const response = await request(`/api/v1/node-runs/${failed.id}/retry`);
    expect(response.status).toBe(400);
  });

  it('a re-run answers 201 with the one new node run', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const { request, stores } = app({
      runs: [run],
      nodeRuns: [makeNodeRun(run, reviewer.id, { status: 'COMPLETED' })],
    });

    const response = await request(`/api/v1/runs/${run.id}/nodes/${reviewer.id}/rerun`, {});
    expect(response.status).toBe(201);

    const body = (await response.json()) as NodeRun;
    expect(body).toMatchObject({ nodeId: reviewer.id, status: 'READY', attempt: 2 });
    expect([...stores.nodeRunRows.values()]).toHaveLength(2);
  });

  it('a re-run takes an empty body, since RerunRequest has no fields', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const { request } = app({ runs: [run] });
    expect((await request(`/api/v1/runs/${run.id}/nodes/${writer.id}/rerun`)).status).toBe(201);
  });

  it('answers 404 for a node that is not in the run’s snapshot (D82)', async () => {
    const run = makeRun({ snapshot, status: 'COMPLETE' });
    const { request } = app({ runs: [run] });

    const response = await request(
      `/api/v1/runs/${run.id}/nodes/01JBXQ8Z9KQ4R7N2VWXYZ0NONE/rerun`,
      {},
    );
    expect(response.status).toBe(404);
  });

  it('answers 404 for a node run that does not exist', async () => {
    const { request } = app({ runs: [] });
    const response = await request('/api/v1/node-runs/01JBXQ8Z9KQ4R7N2VWXYZ0NONE/retry', {
      withDownstream: true,
    });
    expect(response.status).toBe(404);
  });
});

describe('D388 POST /runs/:id/continue', () => {
  it('answers 200 with the same run, re-opened, and retries what was cut off', async () => {
    const run = makeRun({ snapshot, status: 'HALTED', haltReason: 'crash' });
    const stopped = makeNodeRun(run, writer.id, { status: 'STOPPED' });
    const { request, stores } = app({ runs: [run], nodeRuns: [stopped] });

    const response = await request(`/api/v1/runs/${run.id}/continue`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as Run;
    expect(body).toMatchObject({
      id: run.id,
      status: 'RUNNING',
      allowedActions: ['pause', 'stop'],
    });
    const retries = [...stores.nodeRunRows.values()].filter((row) => row.status === 'READY');
    expect(retries).toMatchObject([{ nodeId: writer.id, attempt: 2 }]);
  });

  it('answers 409 `nothing_to_continue` in the §2.3 envelope when nothing was cut off', async () => {
    const run = makeRun({ snapshot, status: 'HALTED', haltReason: 'stopped' });
    const { request } = app({
      runs: [run],
      nodeRuns: [makeNodeRun(run, writer.id, { status: 'COMPLETED' })],
    });

    const response = await request(`/api/v1/runs/${run.id}/continue`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as ApiError).error).toMatchObject({
      kind: 'workflow',
      code: 'nothing_to_continue',
    });
  });

  it('answers 409 `invalid_run_state` for a run that halted on a failure', async () => {
    const run = makeRun({ snapshot, status: 'HALTED', haltReason: 'failure' });
    const { request } = app({
      runs: [run],
      nodeRuns: [makeNodeRun(run, writer.id, { status: 'STOPPED' })],
    });

    const response = await request(`/api/v1/runs/${run.id}/continue`);
    expect(response.status).toBe(409);
    const body = (await response.json()) as ApiError;
    expect(body.error.code).toBe('invalid_run_state');
    expect(body.error.details).toMatchObject({ status: 'HALTED', allowedActions: ['restart'] });
  });
});

describe('An app built without the controls answers `not_implemented`, not a 500', () => {
  it('refuses every control endpoint the way the gateway refuses a service it lacks', async () => {
    const hono = new Hono();
    hono.onError((error, c) => {
      const { status, body } = toApiError(error);
      return c.json(body, status as 400);
    });
    hono.route(
      '/api/v1',
      createRunControlRoutes(() => undefined),
    );

    for (const path of [
      '/api/v1/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RN55/pause',
      '/api/v1/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RN55/resume',
      '/api/v1/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RN55/stop',
      '/api/v1/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RN55/restart',
      '/api/v1/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RN55/continue',
    ]) {
      const response = await hono.request(path, { method: 'POST' });
      expect(response.status).toBe(501);
      expect(((await response.json()) as ApiError).error.code).toBe('not_implemented');
    }
  });
});
