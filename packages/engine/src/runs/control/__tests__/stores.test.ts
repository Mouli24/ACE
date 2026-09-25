import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../../__tests__/fake-repository.js';
import { LOCAL_SCOPE } from '../../../ports/index.js';
import { controlStoresFor, nodeRunStoreFor, runStoreFor } from '../stores.js';
import { agentNode, makeNodeRun, makeRun } from './harness.js';

/**
 * The stores bind to a real `Repository` with the scope already applied.
 *
 * What these tests pin is the binding — one scope, the right rows, newest first. The round-3 patch
 * fields (`pausedAt`, `allowedActions`, `restartedFromRunId`) are declared on `ControlRunPatch` and
 * are **not** asserted here on purpose: `ports/run-repository.ts` has yet to carry them, so a
 * repository built on it drops them, which is precisely the wiring this feature is asking for.
 */

const scope = LOCAL_SCOPE;
const writer = agentNode('Writer');

describe('FR-CTL-001..006 the control stores bind to the repository', () => {
  it('reads and writes a run through the bound scope', async () => {
    const repository = new FakeRepository();
    const store = runStoreFor(repository.runs, scope);

    const run = makeRun({ status: 'RUNNING' });
    expect(await store.create(run)).toEqual(run);
    expect(await store.get(run.id)).toEqual(run);

    const paused = await store.update(run.id, { status: 'PAUSED' });
    expect(paused?.status).toBe('PAUSED');
    expect(await store.get('01JBXQ8Z9KQ4R7N2VWXYZ0NONE')).toBeNull();
  });

  it('lists a workflow’s runs newest first, capped at the limit (D83)', async () => {
    const repository = new FakeRepository();
    const store = runStoreFor(repository.runs, scope);

    const first = makeRun({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN01', startedAt: '2026-09-26T09:00:00.000Z' });
    const second = makeRun({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN02', startedAt: '2026-09-26T10:00:00.000Z' });
    const third = makeRun({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN03', startedAt: '2026-09-26T11:00:00.000Z' });
    for (const run of [first, second, third]) await store.create(run);

    const recent = await store.recentForWorkflow(first.workflowId, 2);
    expect(recent.map((run) => run.id)).toEqual([third.id, second.id]);
  });

  it('answers empty for a workflow with no runs', async () => {
    const repository = new FakeRepository();
    const store = runStoreFor(repository.runs, scope);
    expect(await store.recentForWorkflow('01JBXQ8Z9KQ4R7N2VWXYZ0WKF2', 10)).toEqual([]);
  });

  it('reads and writes node runs, and lists only this run’s', async () => {
    const repository = new FakeRepository();
    const runs = runStoreFor(repository.runs, scope);
    const nodeRuns = nodeRunStoreFor(repository.nodeRuns, scope);

    const run = await runs.create(makeRun({ status: 'RUNNING' }));
    const other = await runs.create(makeRun({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN09' }));

    const mine = await nodeRuns.create(makeNodeRun(run, writer.id, { status: 'READY' }));
    await nodeRuns.create(makeNodeRun(other, writer.id, { status: 'READY' }));

    expect((await nodeRuns.listByRun(run.id)).map((row) => row.id)).toEqual([mine.id]);
    expect(await nodeRuns.get(mine.id)).toEqual(mine);
    expect((await nodeRuns.update(mine.id, { status: 'PAUSED' }))?.status).toBe('PAUSED');
    expect(await nodeRuns.get('01JBXQ8Z9KQ4R7N2VWXYZ0NONE')).toBeNull();
    expect(await nodeRuns.update('01JBXQ8Z9KQ4R7N2VWXYZ0NONE', { status: 'PAUSED' })).toBeNull();
  });

  it('builds both stores from one repository — the call the composition root makes', async () => {
    const repository = new FakeRepository();
    const stores = controlStoresFor(repository, scope);

    const run = await stores.runs.create(makeRun({ status: 'RUNNING' }));
    const nodeRun = await stores.nodeRuns.create(makeNodeRun(run, writer.id));

    expect(await stores.runs.get(run.id)).toEqual(run);
    expect(await stores.nodeRuns.listByRun(run.id)).toEqual([nodeRun]);
  });

  it('answers null when there is no row to update', async () => {
    const repository = new FakeRepository();
    const store = runStoreFor(repository.runs, scope);
    expect(await store.update('01JBXQ8Z9KQ4R7N2VWXYZ0NONE', { status: 'HALTED' })).toBeNull();
  });
});
