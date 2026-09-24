import type { NodeRun, Run } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createEventBus, type EventBus } from '../events/index.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent } from '../ports/index.js';
import { haltActiveRuns, recoverAfterCrash, type LifecycleDeps } from '../runs/lifecycle.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

const scope = LOCAL_SCOPE;
const NOW = '2026-09-22T10:00:00.000Z';
const LATER = '2026-09-22T10:05:00.000Z';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';

const run = (id: string, status: Run['status']): Run => ({
  id,
  workflowId: WORKFLOW_ID,
  projectId: '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC',
  status,
  snapshot: { version: 1, nodes: [], edges: [] },
  inputs: {},
  preflightIssues: [],
  totals: { tokensIn: 3, tokensOut: 4, costUsd: 0.01 },
  startedAt: NOW,
});

const nodeRun = (id: string, runId: string, status: NodeRun['status']): NodeRun => ({
  id,
  runId,
  nodeId: NODE_ID,
  iteration: 1,
  attempt: 1,
  status,
  inputEnvelopes: [],
  usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  verdicts: [],
  toolCalls: [],
});

let repository: FakeRepository;
let bus: EventBus;
let events: EngineEvent[];
let deps: LifecycleDeps;

beforeEach(async () => {
  repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  bus = createEventBus({ repository, scope, pubsub, now: () => LATER });
  events = [];
  await bus.subscribe((event) => events.push(event));

  deps = {
    repository,
    scope,
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => LATER,
  };
});

describe('TC-SYS-010 a run the store still thinks is going did not survive the restart', () => {
  it.each(['RUNNING', 'PREFLIGHT', 'PAUSED'] as const)('halts a %s run as crash', async (status) => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN51', status));

    const result = await recoverAfterCrash(deps);

    expect(result.runs).toEqual(['01JBXQ8Z9KQ4R7N2VWXYZ0RN51']);
    const stored = await repository.runs.get(scope, '01JBXQ8Z9KQ4R7N2VWXYZ0RN51');
    expect(stored?.status).toBe('HALTED');
    expect(stored?.haltReason).toBe('crash');
  });

  it('leaves a run that already finished alone', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN52', 'COMPLETE'));

    expect((await recoverAfterCrash(deps)).runs).toEqual([]);
    expect((await repository.runs.get(scope, '01JBXQ8Z9KQ4R7N2VWXYZ0RN52'))?.status).toBe('COMPLETE');
  });

  it('STOPs the node runs nothing is running any more', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'RUNNING'));
    await repository.nodeRuns.create(
      scope,
      nodeRun('01JBXQ8Z9KQ4R7N2VWXYZ0NRN1', '01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'RUNNING'),
    );
    await repository.nodeRuns.create(
      scope,
      nodeRun('01JBXQ8Z9KQ4R7N2VWXYZ0NRN2', '01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'COMPLETED'),
    );

    const result = await recoverAfterCrash(deps);

    expect(result.nodeRuns).toEqual(['01JBXQ8Z9KQ4R7N2VWXYZ0NRN1']);
    const nodeRuns = await repository.nodeRuns.listByRun(scope, '01JBXQ8Z9KQ4R7N2VWXYZ0RN51');
    expect(nodeRuns.find((n) => n.id === '01JBXQ8Z9KQ4R7N2VWXYZ0NRN1')?.status).toBe('STOPPED');
    expect(nodeRuns.find((n) => n.id === '01JBXQ8Z9KQ4R7N2VWXYZ0NRN2')?.status).toBe('COMPLETED');
  });

  it('STOPs a node that was waiting or queued too — nothing is going to arrive', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'RUNNING'));
    await repository.nodeRuns.create(
      scope,
      nodeRun('01JBXQ8Z9KQ4R7N2VWXYZ0NRN3', '01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'READY'),
    );
    await repository.nodeRuns.create(
      scope,
      nodeRun('01JBXQ8Z9KQ4R7N2VWXYZ0NRN4', '01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'WAITING'),
    );

    expect((await recoverAfterCrash(deps)).nodeRuns).toHaveLength(2);
  });

  it('tells a watching client the run is over', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'RUNNING'));

    await recoverAfterCrash(deps);

    const completed = events.filter((event) => event.type === 'run.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ status: 'HALTED', haltReason: 'crash' });
  });

  it('records how long the run had been going before it died', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'RUNNING'));

    await recoverAfterCrash(deps);

    expect((await repository.runs.get(scope, '01JBXQ8Z9KQ4R7N2VWXYZ0RN51'))?.durationMs).toBe(
      5 * 60 * 1000,
    );
  });

  it('does nothing, quietly, on a clean start', async () => {
    expect(await recoverAfterCrash(deps)).toEqual({ runs: [], nodeRuns: [] });
    expect(events).toEqual([]);
  });
});

describe('TC-SYS-009 stopping the engine halts what was still going', () => {
  it('halts an active run as shutdown, not crash', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'RUNNING'));

    const halted = await haltActiveRuns(deps);

    expect(halted).toEqual(['01JBXQ8Z9KQ4R7N2VWXYZ0RN51']);
    const stored = await repository.runs.get(scope, '01JBXQ8Z9KQ4R7N2VWXYZ0RN51');
    expect(stored?.status).toBe('HALTED');
    expect(stored?.haltReason).toBe('shutdown');
  });

  it('keeps the totals the run had spent by then', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'RUNNING'));

    await haltActiveRuns(deps);

    expect((await repository.runs.get(scope, '01JBXQ8Z9KQ4R7N2VWXYZ0RN51'))?.totals.tokensOut).toBe(4);
  });

  it('halts every active run, not just the first', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'RUNNING'));
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN52', 'PREFLIGHT'));

    expect(await haltActiveRuns(deps)).toHaveLength(2);
  });

  it('is a no-op when nothing was running', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN52', 'COMPLETE'));

    expect(await haltActiveRuns(deps)).toEqual([]);
  });

  it('BR-03 keeps shutdown and crash apart, because they read differently in a history', async () => {
    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN51', 'RUNNING'));
    await haltActiveRuns(deps);

    await repository.runs.create(scope, run('01JBXQ8Z9KQ4R7N2VWXYZ0RN52', 'RUNNING'));
    await recoverAfterCrash(deps);

    expect((await repository.runs.get(scope, '01JBXQ8Z9KQ4R7N2VWXYZ0RN51'))?.haltReason).toBe(
      'shutdown',
    );
    expect((await repository.runs.get(scope, '01JBXQ8Z9KQ4R7N2VWXYZ0RN52'))?.haltReason).toBe('crash');
  });
});
