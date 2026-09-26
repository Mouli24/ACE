import { allowedRunActions, type BudgetHalt, type Model, type NodeRun, type Provider, type Run } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDb, type TempDb } from './temp-db.js';
import { makeInputNode, makeOutputNode, scope } from './fixtures.js';

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const NOW = '2026-09-22T10:00:00.000Z';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const MODEL_ROW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';
const OTHER = { workspaceId: 'other' };
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const NODE_A = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const NODE_B = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const inputNode = makeInputNode(WORKFLOW_ID, NODE_A);
const outputNode = makeOutputNode(WORKFLOW_ID, NODE_B);

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  id: PROVIDER_ID,
  type: 'mock',
  name: 'Mock',
  keySet: false,
  status: 'UNKNOWN',
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const model = (overrides: Partial<Model> = {}): Model => ({
  id: MODEL_ROW_ID,
  providerId: PROVIDER_ID,
  modelId: 'mock-text',
  displayName: 'Mock text',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  ...overrides,
});

const run = (overrides: Partial<Run> = {}): Run => ({
  id: RUN_ID,
  workflowId: WORKFLOW_ID,
  projectId: PROJECT_ID,
  status: 'RUNNING',
  snapshot: { version: 3, nodes: [inputNode, outputNode], edges: [] },
  inputs: {},
  preflightIssues: [],
  totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  startedAt: NOW,
  ...overrides,
});

const nodeRun = (overrides: Partial<NodeRun> = {}): NodeRun => ({
  id: NODE_RUN_ID,
  runId: RUN_ID,
  nodeId: NODE_A,
  iteration: 1,
  attempt: 1,
  status: 'RUNNING',
  inputEnvelopes: [],
  usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  verdicts: [],
  toolCalls: [],
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* providers                                                                   */
/* -------------------------------------------------------------------------- */

describe('FR-PRV-001 providers repository', () => {
  it('round-trips a provider through SQLite unchanged', async () => {
    await db.repository.providers.create(scope, provider());

    expect(await db.repository.providers.get(scope, PROVIDER_ID)).toEqual(provider());
  });

  it('keeps every optional field it was given', async () => {
    const full = provider({
      baseUrl: 'http://127.0.0.1:11434',
      keySet: true,
      status: 'AUTH_FAILED',
      statusMessage: 'bad key',
      lastCheckedAt: NOW,
      concurrency: 2,
    });

    await db.repository.providers.create(scope, full);

    expect(await db.repository.providers.get(scope, PROVIDER_ID)).toEqual(full);
  });

  it('lists providers oldest first, so the list is stable across reloads', async () => {
    await db.repository.providers.create(scope, provider());
    await db.repository.providers.create(
      scope,
      provider({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0PRVE', name: 'Second' }),
    );

    expect((await db.repository.providers.list(scope)).map((p) => p.name)).toEqual([
      'Mock',
      'Second',
    ]);
  });

  it('updates only the fields the patch names', async () => {
    await db.repository.providers.create(scope, provider());

    const updated = await db.repository.providers.update(scope, PROVIDER_ID, {
      status: 'CONNECTED',
      lastCheckedAt: NOW,
      updatedAt: NOW,
    });

    expect(updated?.status).toBe('CONNECTED');
    expect(updated?.name).toBe('Mock');
  });

  it('returns null when updating a provider that is gone', async () => {
    expect(
      await db.repository.providers.update(scope, PROVIDER_ID, { updatedAt: NOW }),
    ).toBeNull();
  });

  it('deletes a provider and reports whether there was one', async () => {
    await db.repository.providers.create(scope, provider());

    expect(await db.repository.providers.delete(scope, PROVIDER_ID)).toBe(true);
    expect(await db.repository.providers.delete(scope, PROVIDER_ID)).toBe(false);
    expect(await db.repository.providers.get(scope, PROVIDER_ID)).toBeNull();
  });

  it('never returns another workspace rows (BR-18)', async () => {
    await db.repository.providers.create(scope, provider());

    expect(await db.repository.providers.get(OTHER, PROVIDER_ID)).toBeNull();
    expect(await db.repository.providers.list(OTHER)).toEqual([]);
  });

  it('TC-PRV-002 stores no key column at all', async () => {
    await db.repository.providers.create(scope, provider({ keySet: true }));

    const columns = db.sqlite.prepare('PRAGMA table_info(providers)').all() as { name: string }[];

    expect(columns.map((c) => c.name)).not.toContain('api_key');
    expect(columns.map((c) => c.name)).toContain('key_set');
  });
});

/* -------------------------------------------------------------------------- */
/* models                                                                      */
/* -------------------------------------------------------------------------- */

describe('FR-MOD-003 models repository', () => {
  it('round-trips a catalog row', async () => {
    await db.repository.models.replaceForProvider(scope, PROVIDER_ID, [model()]);

    expect(await db.repository.models.list(scope, {})).toEqual([model()]);
  });

  it('keeps pricing with its table version (FR-OBS-003)', async () => {
    const priced = model({
      pricing: { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
    });
    await db.repository.models.replaceForProvider(scope, PROVIDER_ID, [priced]);

    expect((await db.repository.models.list(scope, {}))[0]?.pricing).toEqual(priced.pricing);
  });

  it('replaces a provider catalog rather than accumulating duplicates', async () => {
    await db.repository.models.replaceForProvider(scope, PROVIDER_ID, [model(), model({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE2', modelId: 'mock-slow' })]);
    await db.repository.models.replaceForProvider(scope, PROVIDER_ID, [model()]);

    expect(await db.repository.models.list(scope, {})).toHaveLength(1);
  });

  it('TC-MOD-003 filters by provider, data type and availability', async () => {
    await db.repository.models.replaceForProvider(scope, PROVIDER_ID, [
      model(),
      model({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE2', modelId: 'mock-vision', inputTypes: ['text', 'image'] }),
      model({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE3', modelId: 'mock-gone', available: false }),
    ]);

    expect(await db.repository.models.list(scope, { inputType: 'image' })).toHaveLength(1);
    expect(await db.repository.models.list(scope, { available: true })).toHaveLength(2);
    expect(await db.repository.models.list(scope, { available: false })).toHaveLength(1);
    expect(await db.repository.models.list(scope, { outputType: 'json' })).toHaveLength(0);
    expect(await db.repository.models.list(scope, { providerId: MODEL_ROW_ID })).toHaveLength(0);
  });

  it('finds one model by its provider-side id', async () => {
    await db.repository.models.replaceForProvider(scope, PROVIDER_ID, [model()]);

    expect((await db.repository.models.find(scope, PROVIDER_ID, 'mock-text'))?.displayName).toBe(
      'Mock text',
    );
    expect(await db.repository.models.find(scope, PROVIDER_ID, 'nope')).toBeNull();
  });

  it('deletes a provider catalog when the provider goes', async () => {
    await db.repository.models.replaceForProvider(scope, PROVIDER_ID, [model()]);
    await db.repository.models.deleteForProvider(scope, PROVIDER_ID);

    expect(await db.repository.models.list(scope, {})).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* price tables                                                                */
/* -------------------------------------------------------------------------- */

describe('FR-OBS-003 price tables are immutable once written', () => {
  const table = { 'mock-text': { inputPer1k: 0.001, outputPer1k: 0.002 } };

  it('stores a version and reads it back', async () => {
    await db.repository.priceTables.put(scope, { version: 'mock-v1', data: table, createdAt: NOW });

    expect((await db.repository.priceTables.get(scope, 'mock-v1'))?.data).toEqual(table);
  });

  it('keeps the first write when the same version is written again', async () => {
    await db.repository.priceTables.put(scope, { version: 'mock-v1', data: table, createdAt: NOW });
    await db.repository.priceTables.put(scope, {
      version: 'mock-v1',
      data: { 'mock-text': { inputPer1k: 999, outputPer1k: 999 } },
      createdAt: '2026-10-01T00:00:00.000Z',
    });

    expect((await db.repository.priceTables.get(scope, 'mock-v1'))?.data).toEqual(table);
  });

  it('keeps every version side by side', async () => {
    await db.repository.priceTables.put(scope, { version: 'v1', data: table, createdAt: NOW });
    await db.repository.priceTables.put(scope, { version: 'v2', data: table, createdAt: NOW });

    expect((await db.repository.priceTables.list(scope)).map((t) => t.version)).toEqual(['v1', 'v2']);
  });

  it('returns null for a version nobody wrote', async () => {
    expect(await db.repository.priceTables.get(scope, 'v9')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* runs and node runs                                                          */
/* -------------------------------------------------------------------------- */

describe('BR-04 runs repository', () => {
  it('round-trips a run with its snapshot', async () => {
    await db.repository.runs.create(scope, run());

    const stored = await db.repository.runs.get(scope, RUN_ID);

    expect(stored).toEqual(run());
    expect(stored?.snapshot.nodes).toHaveLength(2);
  });

  it('round-trips inputs, preflight issues and the final output', async () => {
    const full = run({
      status: 'COMPLETE',
      inputs: { [NODE_A]: [{ type: 'text', text: 'a sentence' }] },
      preflightIssues: [{ severity: 'error', code: 'provider_missing', message: 'no provider' }],
      finalOutput: { [NODE_B]: [{ type: 'text', text: 'done' }] },
      endedAt: NOW,
      durationMs: 42,
      haltReason: undefined,
    });

    await db.repository.runs.create(scope, full);

    expect(await db.repository.runs.get(scope, RUN_ID)).toEqual(full);
  });

  it('updates status, totals and the ending without touching the snapshot', async () => {
    await db.repository.runs.create(scope, run());

    const updated = await db.repository.runs.update(scope, RUN_ID, {
      status: 'COMPLETE',
      totals: { tokensIn: 5, tokensOut: 9, costUsd: 0.01, priceTableVersion: 'mock-v1' },
      endedAt: NOW,
      durationMs: 120,
    });

    expect(updated?.status).toBe('COMPLETE');
    expect(updated?.totals.tokensOut).toBe(9);
    expect(updated?.snapshot.version).toBe(3);
  });

  it('TC-EXE-011 lists runs of one workflow newest first', async () => {
    const workflowId = WORKFLOW_ID;
    await db.repository.runs.create(scope, run({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN51', workflowId }));
    await db.repository.runs.create(scope, run({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN52', workflowId }));
    await db.repository.runs.create(scope, run({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN53', workflowId }));

    const page = await db.repository.runs.listByWorkflow(scope, workflowId, { limit: 50 });

    expect(page.items.map((r) => r.id)).toEqual([
      '01JBXQ8Z9KQ4R7N2VWXYZ0RN53',
      '01JBXQ8Z9KQ4R7N2VWXYZ0RN52',
      '01JBXQ8Z9KQ4R7N2VWXYZ0RN51',
    ]);
  });

  it('pages the history with a cursor', async () => {
    const workflowId = WORKFLOW_ID;
    for (const suffix of ['1', '2', '3']) {
      await db.repository.runs.create(scope, {
        ...run({ id: `01JBXQ8Z9KQ4R7N2VWXYZ0RN5${suffix}`, workflowId }),
      });
    }

    const first = await db.repository.runs.listByWorkflow(scope, workflowId, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await db.repository.runs.listByWorkflow(scope, workflowId, {
      limit: 2,
      ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
    });
    expect(second.items.map((r) => r.id)).toEqual(['01JBXQ8Z9KQ4R7N2VWXYZ0RN51']);
  });

  it('FR-CTL-006 carries `allowedActions` from the contract’s own table, not a second copy', async () => {
    // Created PREFLIGHT, which `allowedRunActions` says accepts nothing — an empty array, which is
    // exactly the value a dropped column used to be indistinguishable from.
    await db.repository.runs.create(
      scope,
      run({ status: 'PREFLIGHT', allowedActions: allowedRunActions('PREFLIGHT') }),
    );

    expect((await db.repository.runs.get(scope, RUN_ID))?.allowedActions).toEqual(
      allowedRunActions('PREFLIGHT'),
    );

    // Pre-flight passes: the status and the actions are stamped together (D71, D76).
    const running = await db.repository.runs.update(scope, RUN_ID, {
      status: 'RUNNING',
      allowedActions: allowedRunActions('RUNNING'),
    });
    expect(running?.allowedActions).toEqual(['pause', 'stop']);
    expect((await db.repository.runs.get(scope, RUN_ID))?.allowedActions).toEqual([
      'pause',
      'stop',
    ]);

    // And each later status brings its own row of the table through SQLite unchanged.
    for (const status of ['PAUSED', 'COMPLETE', 'BLOCKED', 'HALTED'] as const) {
      const patched = await db.repository.runs.update(scope, RUN_ID, {
        status,
        allowedActions: allowedRunActions(status),
      });
      expect(patched?.allowedActions, `allowedActions for a ${status} run`).toEqual(
        allowedRunActions(status),
      );
    }
  });

  it('FR-CTL-002 writes `pausedAt` on a pause and removes it on a resume', async () => {
    await db.repository.runs.create(
      scope,
      run({ status: 'RUNNING', allowedActions: allowedRunActions('RUNNING') }),
    );

    const paused = await db.repository.runs.update(scope, RUN_ID, {
      status: 'PAUSED',
      pausedAt: '2026-09-26T11:00:00.000Z',
      allowedActions: allowedRunActions('PAUSED'),
    });
    expect(paused?.pausedAt).toBe('2026-09-26T11:00:00.000Z');

    // An unrelated patch leaves the timestamp alone: `undefined` is not a removal.
    const untouched = await db.repository.runs.update(scope, RUN_ID, {
      totals: { tokensIn: 1, tokensOut: 2, costUsd: 0 },
    });
    expect(untouched?.pausedAt).toBe('2026-09-26T11:00:00.000Z');

    // `null` is (D106, following D72): "paused since" has no meaning once the run is running.
    const resumed = await db.repository.runs.update(scope, RUN_ID, {
      status: 'RUNNING',
      pausedAt: null,
      allowedActions: allowedRunActions('RUNNING'),
    });
    expect(resumed?.pausedAt).toBeUndefined();
    expect('pausedAt' in (resumed ?? {})).toBe(false);
    expect((await db.repository.runs.get(scope, RUN_ID))?.pausedAt).toBeUndefined();
  });

  it('FR-GRD-008 round-trips a budget halt whole, beside its halt reason', async () => {
    const budgetHalt: BudgetHalt = { scope: 'daily', capUsd: 0.01, costUsd: 0.012, projected: true };
    await db.repository.runs.create(
      scope,
      run({ status: 'RUNNING', allowedActions: allowedRunActions('RUNNING') }),
    );

    const halted = await db.repository.runs.update(scope, RUN_ID, {
      status: 'HALTED',
      haltReason: 'budget_exceeded',
      budgetHalt,
      endedAt: NOW,
      allowedActions: allowedRunActions('HALTED'),
    });

    // Whole, not summarised: D80 exists so the run view can name the cap and the overspend.
    expect(halted?.budgetHalt).toEqual(budgetHalt);
    expect(halted?.haltReason).toBe('budget_exceeded');
    expect((await db.repository.runs.get(scope, RUN_ID))?.budgetHalt).toEqual(budgetHalt);
  });

  it('FR-CTL-004 records which run a restart came from, on create and on update', async () => {
    const RESTART_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN99';
    await db.repository.runs.create(scope, run({ status: 'HALTED', haltReason: 'stopped' }));

    // A restart is a new run, so the marker normally arrives with the row.
    await db.repository.runs.create(
      scope,
      run({
        id: RESTART_ID,
        status: 'PREFLIGHT',
        restartedFromRunId: RUN_ID,
        allowedActions: allowedRunActions('PREFLIGHT'),
      }),
    );
    expect((await db.repository.runs.get(scope, RESTART_ID))?.restartedFromRunId).toBe(RUN_ID);

    // The patch path has to work too: the port declares it, so the column must honour it.
    const patched = await db.repository.runs.update(scope, RUN_ID, {
      restartedFromRunId: RESTART_ID,
    });
    expect(patched?.restartedFromRunId).toBe(RESTART_ID);
  });

  it('FR-CTL-006 leaves the round 3 fields absent on a run that never set them', async () => {
    // The `undefined` half of every case above: nothing invents an empty array or a timestamp.
    await db.repository.runs.create(scope, run());

    const stored = await db.repository.runs.get(scope, RUN_ID);

    expect(stored?.allowedActions).toBeUndefined();
    expect(stored?.pausedAt).toBeUndefined();
    expect(stored?.budgetHalt).toBeUndefined();
    expect(stored?.restartedFromRunId).toBeUndefined();
    expect(stored).toEqual(run());
  });

  it('lists the runs that were still going when the engine stopped (FR-SYS-009)', async () => {
    await db.repository.runs.create(scope, run({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN51', status: 'RUNNING' }));
    await db.repository.runs.create(scope, run({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN52', status: 'PREFLIGHT' }));
    await db.repository.runs.create(scope, run({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RN53', status: 'COMPLETE' }));

    expect((await db.repository.runs.listActive(scope)).map((r) => r.id).sort()).toEqual([
      '01JBXQ8Z9KQ4R7N2VWXYZ0RN51',
      '01JBXQ8Z9KQ4R7N2VWXYZ0RN52',
    ]);
  });
});

describe('FR-EXE-010 node runs repository', () => {
  beforeEach(async () => {
    await db.repository.runs.create(scope, run());
  });

  it('round-trips a node run', async () => {
    await db.repository.nodeRuns.create(scope, nodeRun());

    expect(await db.repository.nodeRuns.get(scope, NODE_RUN_ID)).toEqual(nodeRun());
  });

  it('round-trips everything FR-EXE-010 lists', async () => {
    const full = nodeRun({
      status: 'FAILED',
      failureReason: 'CONTRACT_VIOLATION',
      error: { kind: 'agent', code: 'bad_json', message: 'not json', retryable: false },
      modelUsed: { providerId: PROVIDER_ID, modelId: 'mock-text', viaFallback: true },
      output: [{ type: 'text', text: 'answer' }],
      prompt: { version: 'abc123def456', text: '## System\n...' },
      usage: { tokensIn: 3, tokensOut: 40, costUsd: 0.000_083, priceTableVersion: 'mock-v1' },
      startedAt: NOW,
      endedAt: NOW,
      durationMs: 7,
    });

    await db.repository.nodeRuns.create(scope, full);

    expect(await db.repository.nodeRuns.get(scope, NODE_RUN_ID)).toEqual(full);
  });

  it('updates a node run in place as it progresses', async () => {
    await db.repository.nodeRuns.create(scope, nodeRun());

    const updated = await db.repository.nodeRuns.update(scope, NODE_RUN_ID, {
      status: 'COMPLETED',
      output: [{ type: 'text', text: 'done' }],
      usage: { tokensIn: 1, tokensOut: 2, costUsd: 0.000_005 },
      endedAt: NOW,
      durationMs: 5,
    });

    expect(updated?.status).toBe('COMPLETED');
    expect(updated?.output).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('lists the node runs of one run in the order they started', async () => {
    await db.repository.nodeRuns.create(scope, nodeRun({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0NRN1' }));
    await db.repository.nodeRuns.create(scope, nodeRun({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0NRN2' }));

    expect((await db.repository.nodeRuns.listByRun(scope, RUN_ID)).map((n) => n.id)).toEqual([
      '01JBXQ8Z9KQ4R7N2VWXYZ0NRN1',
      '01JBXQ8Z9KQ4R7N2VWXYZ0NRN2',
    ]);
  });

  it('finds the node runs still marked RUNNING after a crash (FR-SYS-009)', async () => {
    await db.repository.nodeRuns.create(scope, nodeRun({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0NRN1', status: 'RUNNING' }));
    await db.repository.nodeRuns.create(scope, nodeRun({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0NRN2', status: 'COMPLETED' }));

    const running = await db.repository.nodeRuns.listByRun(scope, RUN_ID);

    expect(running.filter((n) => n.status === 'RUNNING')).toHaveLength(1);
  });
});

describe('BR-07 a secret can never reach these tables', () => {
  it('refuses a node run whose prompt still holds a credential', async () => {
    await db.repository.runs.create(scope, run());

    await expect(
      db.repository.nodeRuns.create(
        scope,
        nodeRun({
          prompt: { version: 'v1', text: `key: sk-ant-${'api03'}-AAAAAAAAAAAAAAAAAAAAAAAA` },
        }),
      ),
    ).rejects.toThrow(/secret/i);
  });
});
