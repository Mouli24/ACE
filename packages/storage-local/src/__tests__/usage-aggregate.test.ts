import {
  ERROR_KINDS,
  HealthMetricsSchema,
  UsageResponseSchema,
  type ErrorKind,
  type NodeRun,
  type Run,
  type RunState,
  type Usage,
  type UsageGroupBy,
  type Verdict,
} from '@ace/contracts';
import { newId } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scope } from './fixtures.js';
import { createTempDb, type TempDb } from './temp-db.js';

/**
 * The usage and health read models (round 5 §2.6, FR-OBS-002, 004, 007, D234, F10), folded in SQL
 * over `node_runs`, `runs` and `guardrail_verdicts`. Each test seeds rows and checks the answer
 * against a sum it works out by hand over the same rows.
 */

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const OTHER = { workspaceId: 'other' };
const PROVIDER_A = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVA';
const PROVIDER_B = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVB';
const WORKFLOW_1 = '01JBXQ8Z9KQ4R7N2VWXYZ0WKF1';
const WORKFLOW_2 = '01JBXQ8Z9KQ4R7N2VWXYZ0WKF2';
const NODE = '01JBXQ8Z9KQ4R7N2VWXYZ0NODE';

const run = (workflowId: string, startedAt: string, status: RunState = 'COMPLETE'): Run => ({
  id: newId(),
  workflowId,
  projectId: newId(),
  status,
  snapshot: { version: 1, nodes: [], edges: [] },
  inputs: {},
  preflightIssues: [],
  totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  startedAt,
});

interface Seeded {
  nodeRun: NodeRun;
  workflowId: string;
}

const nodeRun = (runId: string, overrides: Partial<NodeRun> & { startedAt?: string }): NodeRun => ({
  id: newId(),
  runId,
  nodeId: NODE,
  iteration: 1,
  attempt: 1,
  status: 'COMPLETED',
  inputEnvelopes: [],
  usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  verdicts: [],
  toolCalls: [],
  ...overrides,
});

const used = (providerId: string, modelId = 'mock-text') => ({
  providerId,
  modelId,
  viaFallback: false,
});

/**
 * Two days, two providers, two workflows — plus a node run that called no model and one that never
 * started, which D234 leaves out. Costs are binary fractions, so every sum is exact.
 */
async function seed(): Promise<Seeded[]> {
  const r1 = run(WORKFLOW_1, '2026-10-01T09:00:00.000Z');
  const r2 = run(WORKFLOW_2, '2026-10-01T23:00:00.000Z');
  await db.repository.runs.create(scope, r1);
  await db.repository.runs.create(scope, r2);

  const rows: Seeded[] = [
    {
      workflowId: WORKFLOW_1,
      nodeRun: nodeRun(r1.id, {
        startedAt: '2026-10-01T09:00:00.000Z',
        modelUsed: used(PROVIDER_A),
        usage: { tokensIn: 100, tokensOut: 40, costUsd: 0.25 },
      }),
    },
    {
      workflowId: WORKFLOW_1,
      nodeRun: nodeRun(r1.id, {
        startedAt: '2026-10-01T09:05:00.000Z',
        modelUsed: used(PROVIDER_B, 'big-model'),
        usage: { tokensIn: 300, tokensOut: 60, costUsd: 1.5 },
      }),
    },
    {
      workflowId: WORKFLOW_2,
      nodeRun: nodeRun(r2.id, {
        startedAt: '2026-10-01T23:30:00.000Z',
        modelUsed: used(PROVIDER_A),
        usage: { tokensIn: 50, tokensOut: 10, costUsd: 0.125 },
      }),
    },
    {
      workflowId: WORKFLOW_2,
      nodeRun: nodeRun(r2.id, {
        startedAt: '2026-10-02T00:10:00.000Z',
        modelUsed: used(PROVIDER_A),
        usage: { tokensIn: 70, tokensOut: 30, costUsd: 0.5 },
      }),
    },
    {
      workflowId: WORKFLOW_2,
      nodeRun: nodeRun(r2.id, {
        startedAt: '2026-10-02T00:20:00.000Z',
        modelUsed: used(PROVIDER_B, 'big-model'),
        usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.0625 },
      }),
    },
  ];
  for (const row of rows) await db.repository.nodeRuns.create(scope, row.nodeRun);

  // Left out (D234): no model was called, and a node run that never started.
  await db.repository.nodeRuns.create(
    scope,
    nodeRun(r1.id, {
      startedAt: '2026-10-01T09:10:00.000Z',
      usage: { tokensIn: 999, tokensOut: 999, costUsd: 99 },
    }),
  );
  await db.repository.nodeRuns.create(
    scope,
    nodeRun(r1.id, {
      status: 'IDLE',
      modelUsed: used(PROVIDER_A),
      usage: { tokensIn: 999, tokensOut: 999, costUsd: 99 },
    }),
  );
  return rows;
}

/** The hand-made fold the store must equal: D234 over the seeded rows, in plain TypeScript. */
function manualFold(
  rows: readonly Seeded[],
  groupBy: readonly UsageGroupBy[],
  from?: string,
  to?: string,
) {
  const groups = new Map<
    string,
    { key: Record<string, string>; usage: Usage; runs: Set<string> }
  >();
  for (const { nodeRun: row, workflowId } of rows) {
    const startedAt = Date.parse(row.startedAt!);
    if (from !== undefined && startedAt < Date.parse(from)) continue;
    if (to !== undefined && startedAt >= Date.parse(to)) continue;
    const values: Record<UsageGroupBy, string> = {
      provider: row.modelUsed!.providerId,
      model: row.modelUsed!.modelId,
      day: new Date(startedAt).toISOString().slice(0, 10),
      workflow: workflowId,
    };
    const key = Object.fromEntries(groupBy.map((by) => [by, values[by]]));
    const id = JSON.stringify(groupBy.map((by) => values[by]));
    const group = groups.get(id) ?? {
      key,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      runs: new Set<string>(),
    };
    group.usage.tokensIn += row.usage.tokensIn;
    group.usage.tokensOut += row.usage.tokensOut;
    group.usage.costUsd += row.usage.costUsd;
    group.runs.add(row.runId);
    groups.set(id, group);
  }
  return [...groups.values()]
    .sort((a, b) => {
      for (const by of groupBy) {
        if (a.key[by] !== b.key[by]) return a.key[by]! < b.key[by]! ? -1 : 1;
      }
      return 0;
    })
    .map((group) => ({ key: group.key, ...group.usage, runs: group.runs.size }));
}

describe('TC-OBS-004 aggregate by provider+day equals a manual sum over node runs', () => {
  it('groups by provider then day, ordered by key, with totals the sum of the buckets', async () => {
    const rows = await seed();

    const result = await db.repository.usage.aggregate(scope, { groupBy: ['provider', 'day'] });

    expect(UsageResponseSchema.parse(result)).toEqual(result);
    expect(result.buckets).toEqual(manualFold(rows, ['provider', 'day']));
    expect(result.buckets.map((bucket) => bucket.key)).toEqual([
      { provider: PROVIDER_A, day: '2026-10-01' },
      { provider: PROVIDER_A, day: '2026-10-02' },
      { provider: PROVIDER_B, day: '2026-10-01' },
      { provider: PROVIDER_B, day: '2026-10-02' },
    ]);
    // `runs` counts distinct runs: provider A on day one was called by both runs.
    expect(result.buckets[0]!.runs).toBe(2);

    const sum = (field: 'tokensIn' | 'tokensOut' | 'costUsd') =>
      result.buckets.reduce((total, bucket) => total + bucket[field], 0);
    expect(result.totals).toEqual({
      tokensIn: sum('tokensIn'),
      tokensOut: sum('tokensOut'),
      costUsd: sum('costUsd'),
    });
    expect(result.totals).toEqual({ tokensIn: 530, tokensOut: 145, costUsd: 2.4375 });
  });

  it('orders by the groupings in the order asked', async () => {
    const rows = await seed();

    const byDay = await db.repository.usage.aggregate(scope, { groupBy: ['day', 'provider'] });
    expect(byDay.buckets).toEqual(manualFold(rows, ['day', 'provider']));
    expect(byDay.buckets.map((bucket) => bucket.key.day)).toEqual([
      '2026-10-01',
      '2026-10-01',
      '2026-10-02',
      '2026-10-02',
    ]);

    for (const groupBy of [['model'], ['workflow'], ['workflow', 'model', 'day']] as const) {
      const result = await db.repository.usage.aggregate(scope, { groupBy: [...groupBy] });
      expect(result.buckets).toEqual(manualFold(rows, groupBy));
    }
  });

  it('counts from inclusive and to exclusive, against the node run start', async () => {
    const rows = await seed();
    const from = '2026-10-01T09:05:00.000Z';
    const to = '2026-10-02T00:20:00.000Z';

    const result = await db.repository.usage.aggregate(scope, { from, to, groupBy: ['provider'] });

    expect(result.buckets).toEqual(manualFold(rows, ['provider'], from, to));
    // 09:05 is in (from is inclusive), 00:20 is out (to is exclusive), 09:00 is before from.
    expect(result.totals).toEqual({ tokensIn: 420, tokensOut: 100, costUsd: 2.125 });
  });

  it('orders key values by binary comparison, as SQLite does — not by locale', async () => {
    const r = run(WORKFLOW_1, '2026-10-01T09:00:00.000Z');
    await db.repository.runs.create(scope, r);
    for (const modelId of ['alpha', 'Zeta', 'beta']) {
      await db.repository.nodeRuns.create(
        scope,
        nodeRun(r.id, {
          startedAt: '2026-10-01T09:00:00.000Z',
          modelUsed: used(PROVIDER_A, modelId),
          usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
        }),
      );
    }

    const result = await db.repository.usage.aggregate(scope, { groupBy: ['model'] });
    expect(result.buckets.map((bucket) => bucket.key.model)).toEqual(['Zeta', 'alpha', 'beta']);
  });

  it('keys a day by the UTC date of the start, whatever offset it was written with', async () => {
    const r = run(WORKFLOW_1, '2026-10-01T20:00:00.000Z');
    await db.repository.runs.create(scope, r);
    await db.repository.nodeRuns.create(
      scope,
      nodeRun(r.id, {
        // 01:30 on the 2nd in +05:30 is 20:00 on the 1st in UTC.
        startedAt: '2026-10-02T01:30:00.000+05:30',
        modelUsed: used(PROVIDER_A),
        usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.5 },
      }),
    );

    const result = await db.repository.usage.aggregate(scope, { groupBy: ['day'] });
    expect(result.buckets.map((bucket) => bucket.key.day)).toEqual(['2026-10-01']);
    expect((await db.repository.usage.dayTotals(scope, '2026-10-01')).costUsd).toBe(0.5);
  });

  it('answers empty buckets and zero totals with nothing to count, and keeps tenants apart', async () => {
    expect(await db.repository.usage.aggregate(scope, { groupBy: ['provider'] })).toEqual({
      buckets: [],
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
    await seed();
    expect(await db.repository.usage.aggregate(OTHER, { groupBy: ['provider'] })).toEqual({
      buckets: [],
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
  });
});

describe('FR-OBS-002 dayTotals sums one UTC day of node runs that called a model', () => {
  it('equals the manual sum of the day, and is zero on a day with nothing', async () => {
    const rows = await seed();
    const dayOne = rows.filter(({ nodeRun: row }) => row.startedAt!.startsWith('2026-10-01'));

    expect(await db.repository.usage.dayTotals(scope, '2026-10-01')).toEqual({
      tokensIn: dayOne.reduce((total, { nodeRun: row }) => total + row.usage.tokensIn, 0),
      tokensOut: dayOne.reduce((total, { nodeRun: row }) => total + row.usage.tokensOut, 0),
      costUsd: dayOne.reduce((total, { nodeRun: row }) => total + row.usage.costUsd, 0),
    });
    expect(await db.repository.usage.dayTotals(scope, '2026-10-02')).toEqual({
      tokensIn: 80,
      tokensOut: 35,
      costUsd: 0.5625,
    });
    expect(await db.repository.usage.dayTotals(scope, '2026-09-30')).toEqual({
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    });
    expect((await db.repository.usage.dayTotals(OTHER, '2026-10-01')).costUsd).toBe(0);
  });
});

describe('FR-OBS-007 healthCounts names every ErrorKind', () => {
  const error = (kind: ErrorKind) => ({ kind, code: 'x', message: 'failed', retryable: false });

  it('fills every kind, counts runs by outcome, and starts from the first run (F10)', async () => {
    const first = run(WORKFLOW_1, '2026-10-01T08:00:00.000Z', 'COMPLETE');
    await db.repository.runs.create(scope, run(WORKFLOW_1, '2026-10-01T09:00:00.000Z', 'HALTED'));
    await db.repository.runs.create(scope, first);
    await db.repository.runs.create(scope, run(WORKFLOW_1, '2026-10-01T10:00:00.000Z', 'BLOCKED'));
    await db.repository.runs.create(scope, run(WORKFLOW_1, '2026-10-01T11:00:00.000Z', 'RUNNING'));
    for (const kind of ['provider', 'provider', 'guardrail'] as const) {
      await db.repository.nodeRuns.create(
        scope,
        nodeRun(first.id, { status: 'FAILED', error: error(kind) }),
      );
    }

    const health = await db.repository.usage.healthCounts(scope);

    expect(HealthMetricsSchema.parse(health)).toEqual(health);
    expect(Object.keys(health.nodeFailuresByKind).sort()).toEqual([...ERROR_KINDS].sort());
    expect(health.nodeFailuresByKind).toEqual({
      ...Object.fromEntries(ERROR_KINDS.map((kind) => [kind, 0])),
      provider: 2,
      guardrail: 1,
    });
    expect(health.runs).toEqual({ started: 4, completed: 1, halted: 1, blocked: 1 });
    expect(health.since).toBe('2026-10-01T08:00:00.000Z');
  });

  it('answers p50 and p95 latency per provider from completed node runs', async () => {
    const r = run(WORKFLOW_1, '2026-10-01T08:00:00.000Z');
    await db.repository.runs.create(scope, r);
    for (const durationMs of [400, 100, 300, 200]) {
      await db.repository.nodeRuns.create(
        scope,
        nodeRun(r.id, { modelUsed: used(PROVIDER_A), durationMs }),
      );
    }
    await db.repository.nodeRuns.create(
      scope,
      nodeRun(r.id, { modelUsed: used(PROVIDER_B), durationMs: 50 }),
    );
    // Not completed, or no model: left out of the latency.
    await db.repository.nodeRuns.create(
      scope,
      nodeRun(r.id, { status: 'FAILED', modelUsed: used(PROVIDER_A), durationMs: 9_000 }),
    );
    await db.repository.nodeRuns.create(scope, nodeRun(r.id, { durationMs: 9_000 }));

    const health = await db.repository.usage.healthCounts(scope);
    // Nearest rank: p50 of four is the 2nd, p95 the 4th.
    expect(health.providerLatencyMs).toEqual({
      [PROVIDER_A]: { p50: 200, p95: 400 },
      [PROVIDER_B]: { p50: 50, p95: 50 },
    });
  });

  it('counts the stored verdicts by check type', async () => {
    const verdict = (checkType: Verdict['checkType']): Verdict => ({
      id: newId(),
      nodeRunId: newId(),
      point: 'input',
      checkType,
      action: 'warn',
      passed: true,
      reason: 'ok',
      at: '2026-10-01T08:00:00.000Z',
    });
    for (const type of ['pii', 'pii', 'prompt_injection'] as const) {
      await db.repository.guardrailVerdicts.append(scope, verdict(type));
    }

    const health = await db.repository.usage.healthCounts(scope);
    expect(health.guardrailVerdictsByType).toEqual({ pii: 2, prompt_injection: 1 });
  });

  it('starts from now when no run was ever recorded, and every count is zero', async () => {
    const before = Date.now();
    const health = await db.repository.usage.healthCounts(scope);
    const after = Date.now();

    expect(Date.parse(health.since)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(health.since)).toBeLessThanOrEqual(after);
    expect(health.runs).toEqual({ started: 0, completed: 0, halted: 0, blocked: 0 });
    expect(Object.values(health.nodeFailuresByKind).every((n) => n === 0)).toBe(true);
    expect(health.providerLatencyMs).toEqual({});
    expect(health.guardrailVerdictsByType).toEqual({});
  });
});
