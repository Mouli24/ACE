import {
  ERROR_KINDS,
  PERSISTED_RUN_EVENT_TYPES,
  TRACE_ENTRY_KIND_BY_EVENT_TYPE,
  type HealthMetrics,
  type NodeRun,
  type Run,
  type UsageQuery,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import type { EngineEvent, UsageRepository } from '../ports/index.js';
import { LOCAL_WORKSPACE_ID } from '../ports/index.js';
import { foldTrace, createTraceService } from '../trace/index.js';
import { createUsageService, requireUsageRepository } from '../usage/index.js';
import { healthMetrics } from '../usage/health.js';
import { FakeRepository } from './fake-repository.js';

const scope = { workspaceId: LOCAL_WORKSPACE_ID };
const RUN = '01JBXQ8Z9KQ4R7N2VWXYZ00R01';
const NODE = '01JBXQ8Z9KQ4R7N2VWXYZ00N01';
const NODE_RUN = '01JBXQ8Z9KQ4R7N2VWXYZ00NR1';
const EDGE = '01JBXQ8Z9KQ4R7N2VWXYZ00E01';
const WF = '01JBXQ8Z9KQ4R7N2VWXYZ00W01';
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const verdict = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ00V01',
  nodeRunId: NODE_RUN,
  point: 'input',
  checkType: 'pii',
  action: 'warn',
  passed: false,
  reason: 'found an email',
  at: at(0),
};

const toolCall = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ00T01',
  nodeRunId: NODE_RUN,
  toolName: 'web_search',
  args: { q: 'x' },
  resultSummary: 'ok',
  durationMs: 321,
  status: 'ok',
  verdicts: [],
  at: at(0),
};

const usage = { tokensIn: 1, tokensOut: 2, costUsd: 0.5 };

const state = (status: string, ms: number): [string, unknown, number] => [
  'node.state',
  { runId: RUN, nodeRunId: NODE_RUN, nodeId: NODE, iteration: 1, attempt: 1, status },
  ms,
];

/** One of every persisted run event type, plus a `node.token` and an engine-family event. */
const script: [string, unknown, number][] = [
  ['run.started', { runId: RUN, workflowId: WF }, 0],
  state('RUNNING', 100),
  ['node.token', { runId: RUN, nodeRunId: NODE_RUN, delta: 'hi' }, 150],
  ['guardrail.verdict', { runId: RUN, nodeRunId: NODE_RUN, verdict }, 200],
  ['tool.call', { runId: RUN, nodeRunId: NODE_RUN, toolCall }, 250],
  ['kb.ingest', { knowledgeBaseId: 'kb', documentId: 'd', status: 'ready' }, 260],
  [
    'node.approval_required',
    {
      runId: RUN,
      request: {
        id: '01JBXQ8Z9KQ4R7N2VWXYZ00Q01',
        runId: RUN,
        nodeRunId: NODE_RUN,
        nodeId: NODE,
        nodeName: 'Writer',
        point: 'output',
        checkType: 'pii',
        reason: 'r',
        preview: 'p',
        requestedAt: at(300),
      },
    },
    300,
  ],
  [
    'node.approval_decided',
    {
      runId: RUN,
      nodeRunId: NODE_RUN,
      decision: {
        requestId: '01JBXQ8Z9KQ4R7N2VWXYZ00Q01',
        decision: 'approve',
        decidedAt: at(350),
      },
    },
    350,
  ],
  ['node.output', { runId: RUN, nodeRunId: NODE_RUN, nodeId: NODE, output: [], usage }, 380],
  state('COMPLETED', 600),
  [
    'node.error',
    {
      runId: RUN,
      nodeRunId: NODE_RUN,
      nodeId: NODE,
      error: { kind: 'agent', code: 'c', message: 'm', retryable: false },
      failureReason: 'AGENT_ERROR',
    },
    610,
  ],
  [
    'edge.transfer',
    { runId: RUN, edgeId: EDGE, fromNodeId: NODE, toNodeId: NODE, iteration: 1, summary: 's' },
    620,
  ],
  ['loop.iteration', { runId: RUN, edgeId: EDGE, targetNodeId: NODE, iteration: 2 }, 630],
  [
    'loop.iteration',
    { runId: RUN, edgeId: EDGE, targetNodeId: NODE, iteration: 2, stop: 'max_iterations' },
    640,
  ],
  ['run.paused', { runId: RUN }, 650],
  ['run.resumed', { runId: RUN }, 660],
  ['usage.updated', { runId: RUN, totals: usage }, 670],
  ['message.created', { workflowId: WF, message: {} }, 680],
  ['run.completed', { runId: RUN, status: 'COMPLETE', totals: usage }, 700],
];

const events = (): EngineEvent[] =>
  script.map(([type, payload, ms], index) => ({
    seq: index + 1,
    type,
    runId: RUN,
    workflowId: WF,
    payload,
    createdAt: at(ms),
  }));

describe('TC-OBS-001 the trace has one entry per persisted run event, in seq order, with identical seqs', () => {
  it('folds the log one entry per persisted event with the event seq', () => {
    const log = events();
    const trace = foldTrace([...log].reverse());
    const persisted = log.filter((event) =>
      (PERSISTED_RUN_EVENT_TYPES as readonly string[]).includes(event.type),
    );

    expect(trace.map((entry) => entry.seq)).toEqual(persisted.map((event) => event.seq));
    expect(trace.map((entry) => entry.seq)).toEqual(
      [...trace.map((e) => e.seq)].sort((a, b) => a - b),
    );
    expect(trace.map((entry) => entry.detail)).toEqual(persisted.map((event) => event.payload));
    expect(trace.map((entry) => entry.at)).toEqual(persisted.map((event) => event.createdAt));
  });

  it('every persisted run event type is exercised by the script', () => {
    const seen = new Set(script.map(([type]) => type));
    for (const type of PERSISTED_RUN_EVENT_TYPES) expect(seen.has(type)).toBe(true);
  });

  it('node.token and engine-family events never appear', () => {
    const types = events().map((e) => e.type);
    expect(types).toContain('node.token');
    expect(types).toContain('kb.ingest');
    const trace = foldTrace(events());
    expect(trace.some((entry) => entry.label === 'node.token' || entry.label === 'kb.ingest')).toBe(
      false,
    );
    expect(trace).toHaveLength(events().length - 2);
  });
});

describe('FR-OBS-001 kinds, labels and durations', () => {
  it('kinds follow TRACE_ENTRY_KIND_BY_EVENT_TYPE', () => {
    const log = events().filter(
      (event) => event.type !== 'node.token' && event.type !== 'kb.ingest',
    );
    const trace = foldTrace(log);
    log.forEach((event, index) => {
      expect(trace[index]?.kind).toBe(
        TRACE_ENTRY_KIND_BY_EVENT_TYPE[event.type as keyof typeof TRACE_ENTRY_KIND_BY_EVENT_TYPE],
      );
    });
  });

  it('labels follow the brief and fall back to the event type', () => {
    const labels = foldTrace(events()).map((entry) => entry.label);
    expect(labels).toEqual([
      'run.started',
      `${NODE} → RUNNING`,
      'pii at input: warn',
      'web_search (ok)',
      'approval requested',
      'approval approve',
      'node.output',
      `${NODE} → COMPLETED`,
      'node.error',
      'edge.transfer',
      'loop iteration 2',
      'loop stopped: max_iterations',
      'run.paused',
      'run.resumed',
      'usage.updated',
      'message.created',
      'run.completed',
    ]);
  });

  it("a finished node run's entry carries durationMs from RUNNING", () => {
    const trace = foldTrace(events());
    const running = trace.find((entry) => entry.label.endsWith('RUNNING'));
    const done = trace.find((entry) => entry.label.endsWith('COMPLETED'));

    expect(running?.durationMs).toBeUndefined();
    expect(done?.durationMs).toBe(500);
    expect(done?.nodeId).toBe(NODE);
    expect(done?.nodeRunId).toBe(NODE_RUN);
  });

  it('a tool call carries its durationMs', () => {
    const entry = foldTrace(events()).find((e) => e.kind === 'tool_call');
    expect(entry?.durationMs).toBe(321);
    expect(entry?.nodeRunId).toBe(NODE_RUN);
  });

  it('a terminal state with no RUNNING before it has no duration, and a retry measures its own attempt', () => {
    const lone = foldTrace([
      { seq: 1, type: 'node.state', runId: RUN, payload: state('FAILED', 0)[1], createdAt: at(0) },
    ]);
    expect(lone[0]?.durationMs).toBeUndefined();

    const retried = foldTrace(
      [state('RUNNING', 0), state('RUNNING', 1000), state('FAILED', 1200)].map(
        ([type, payload, ms], index) => ({
          seq: index + 1,
          type,
          runId: RUN,
          payload,
          createdAt: at(ms),
        }),
      ),
    );
    expect(retried[2]?.durationMs).toBe(200);
  });

  it('keeps an entry whose payload is not the contract shape, labelled by its type', () => {
    const trace = foldTrace([
      { seq: 1, type: 'node.state', runId: RUN, payload: { nope: 1 }, createdAt: at(0) },
      { seq: 2, type: 'tool.call', runId: RUN, payload: null, createdAt: at(0) },
      { seq: 3, type: 'guardrail.verdict', runId: RUN, payload: null, createdAt: at(0) },
      { seq: 4, type: 'node.approval_required', runId: RUN, payload: null, createdAt: at(0) },
      { seq: 5, type: 'node.approval_decided', runId: RUN, payload: null, createdAt: at(0) },
      { seq: 6, type: 'loop.iteration', runId: RUN, payload: null, createdAt: at(0) },
      { seq: 7, type: 'node.output', runId: RUN, payload: null, createdAt: at(0) },
      { seq: 8, type: 'node.error', runId: RUN, payload: null, createdAt: at(0) },
    ]);
    expect(trace.map((entry) => entry.label)).toEqual([
      'node.state',
      'tool.call',
      'guardrail.verdict',
      'approval requested',
      'approval decided',
      'loop.iteration',
      'node.output',
      'node.error',
    ]);
  });
});

describe('FR-OBS-001 the trace service', () => {
  it('reads the run own events and 404s an unknown run', async () => {
    const repo = new FakeRepository();
    await repo.runs.create(scope, { id: RUN, workflowId: WF } as unknown as Run);
    for (const event of events()) {
      const { seq: _seq, ...rest } = event;
      await repo.events.append(scope, rest);
    }
    await repo.events.append(scope, {
      type: 'run.started',
      runId: '01JBXQ8Z9KQ4R7N2VWXYZ00R02',
      payload: {},
      createdAt: at(0),
    });

    const service = createTraceService({ repository: repo, scope });
    const trace = await service.trace(RUN);
    expect(trace).toHaveLength(events().length - 2);

    await expect(service.trace('01JBXQ8Z9KQ4R7N2VWXYZ00X01')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('labels a node state by the node name from the run snapshot: Writer → RUNNING', async () => {
    const repo = new FakeRepository();
    await repo.runs.create(scope, {
      id: RUN,
      workflowId: WF,
      snapshot: { version: 1, nodes: [{ id: NODE, name: 'Writer' }], edges: [] },
    } as unknown as Run);
    for (const event of events()) {
      const { seq: _seq, ...rest } = event;
      await repo.events.append(scope, rest);
    }

    const trace = await createTraceService({ repository: repo, scope }).trace(RUN);
    const labels = trace.filter((entry) => entry.kind === 'node_run').map((entry) => entry.label);
    expect(labels).toContain('Writer → RUNNING');
    expect(labels).toContain('Writer → COMPLETED');
  });

  it('falls back to the node id for a node the snapshot does not name', () => {
    const names = new Map([['01JBXQ8Z9KQ4R7N2VWXYZ00N99', 'Other']]);
    const labels = foldTrace(events(), names).map((entry) => entry.label);
    expect(labels).toContain(`${NODE} → RUNNING`);
  });
});

const finishedNodeRun = (id: string, runId: string, tokensIn: number, costUsd: number): NodeRun =>
  ({
    id,
    runId,
    nodeId: NODE,
    status: 'COMPLETED',
    startedAt: '2026-10-01T10:00:00.000Z',
    durationMs: 10,
    modelUsed: { providerId: 'p1', modelId: 'm1', viaFallback: false },
    usage: { tokensIn, tokensOut: 1, costUsd },
  }) as unknown as NodeRun;

describe('usage service', () => {
  it('TC-OBS-002 run totals equal the sum of node runs', async () => {
    const repo = new FakeRepository();
    await repo.runs.create(scope, { id: RUN, workflowId: WF, startedAt: at(0) } as unknown as Run);
    await repo.nodeRuns.create(scope, finishedNodeRun('01JBXQ8Z9KQ4R7N2VWXYZ00NR1', RUN, 10, 0.25));
    await repo.nodeRuns.create(scope, finishedNodeRun('01JBXQ8Z9KQ4R7N2VWXYZ00NR2', RUN, 5, 0.5));

    const service = createUsageService({ usage: requireUsageRepository(repo), scope });
    const response = await service.usage({ groupBy: ['provider'] });

    expect(response.totals).toEqual({ tokensIn: 15, tokensOut: 2, costUsd: 0.75 });
    expect(response.buckets).toHaveLength(1);
    expect(response.buckets[0]).toMatchObject({ key: { provider: 'p1' }, tokensIn: 15, runs: 1 });
    expect((await service.dayTotals('2026-10-01')).totals.tokensIn).toBe(15);
  });

  it('TC-OBS-004 the service passes the query through and returns UsageResponse', async () => {
    const seen: unknown[] = [];
    const answer = { buckets: [], totals: usage };
    const port: UsageRepository = {
      aggregate: async (s, query) => {
        seen.push(s, query);
        return answer;
      },
      dayTotals: async (s, day) => {
        seen.push(s, day);
        return usage;
      },
      healthCounts: async () => {
        throw new Error('unused');
      },
    };
    const service = createUsageService({ usage: port, scope });
    const query: UsageQuery = { from: at(0), to: at(1000), groupBy: ['day', 'model'] };

    expect(await service.usage(query)).toBe(answer);
    expect(await service.dayTotals('2026-10-01')).toEqual({ day: '2026-10-01', totals: usage });
    expect(seen).toEqual([scope, query, scope, '2026-10-01']);
  });

  it('fails clearly when the repository has no usage port', () => {
    expect(() => requireUsageRepository({})).toThrow(/usage port/);
  });

  it('health has every ErrorKind', async () => {
    const repo = new FakeRepository();
    const service = createUsageService({ usage: requireUsageRepository(repo), scope });
    const health = await service.health();
    expect(Object.keys(health.nodeFailuresByKind).sort()).toEqual([...ERROR_KINDS].sort());

    // A store that names only the kinds that failed still answers every kind.
    const sparse: HealthMetrics = {
      runs: { started: 0, completed: 0, halted: 0, blocked: 0 },
      nodeFailuresByKind: { provider: 2 } as HealthMetrics['nodeFailuresByKind'],
      providerLatencyMs: {},
      guardrailVerdictsByType: {},
      since: at(0),
    };
    const filled = await healthMetrics(
      {
        aggregate: async () => ({ buckets: [], totals: usage }),
        dayTotals: async () => usage,
        healthCounts: async () => sparse,
      },
      scope,
    );
    expect(Object.keys(filled.nodeFailuresByKind).sort()).toEqual([...ERROR_KINDS].sort());
    expect(filled.nodeFailuresByKind.provider).toBe(2);
    expect(filled.nodeFailuresByKind.agent).toBe(0);
  });
});
