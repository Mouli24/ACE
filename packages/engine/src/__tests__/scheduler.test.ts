import {
  AgentConfigSchema,
  type Edge,
  type Model,
  type Node,
  type NodeState,
  type Part,
  type Provider,
  type Run,
} from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createEventBus, type EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent, type ModelRouter, type ProviderAdapter } from '../ports/index.js';
import { createRunService, type RunService } from '../runs/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

const scope = LOCAL_SCOPE;
const NOW = '2026-09-22T10:00:00.000Z';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

/* -------------------------------------------------------------------------- */
/* Graph building                                                              */
/* -------------------------------------------------------------------------- */

let workflowId: string;

const port = (nodeId: string, dir: 'in' | 'out', name: string, dataType = 'text', multi = false) => ({
  id: `${nodeId}:${dir}:${name}`,
  name,
  dataType: dataType as 'text',
  multi,
});

function inputNode(name = 'Brief', text = 'the brief'): Node {
  const id = newId();
  return {
    id,
    workflowId,
    kind: 'input',
    name,
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: [port(id, 'out', 'text', 'text', true)],
    config: { text, artifactIds: [], outputTypes: ['text'] },
  };
}

function agentNode(name = 'Agent', config: Record<string, unknown> = {}): Node {
  const id = newId();
  return {
    id,
    workflowId,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    inputs: [port(id, 'in', 'text')],
    outputs: [port(id, 'out', 'text', 'text', true)],
    config: AgentConfigSchema.parse({
      providerId: PROVIDER_ID,
      modelId: 'scripted',
      instructions: `Act as ${name}.`,
      inputTypes: ['text'],
      outputTypes: ['text'],
      ...config,
    }),
  };
}

/** A merge-style agent: one multi input port, so it waits for every upstream (TC-EXE-004). */
function joinAgent(name = 'Join'): Node {
  const node = agentNode(name);
  return { ...node, inputs: [port(node.id, 'in', 'text', 'text', true)] };
}

function outputNode(name = 'Result'): Node {
  const id = newId();
  return {
    id,
    workflowId,
    kind: 'output',
    name,
    position: { x: 0, y: 0 },
    inputs: [port(id, 'in', 'text')],
    outputs: [],
    config: {},
  };
}

const edge = (from: Node, to: Node): Edge => ({
  id: newId(),
  workflowId,
  kind: 'data',
  from: { nodeId: from.id, portId: from.outputs[0]!.id },
  to: { nodeId: to.id, portId: to.inputs[0]!.id },
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const provider: Provider = {
  id: PROVIDER_ID,
  type: 'mock',
  name: 'Mock',
  keySet: false,
  status: 'CONNECTED',
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
};

const model: Model = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'scripted',
  displayName: 'Scripted',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  pricing: { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
};

/** What the scripted provider does for a given node, keyed by the node's instructions. */
let behaviour: (prompt: string) => { text?: string; throws?: unknown; delayMs?: number };
let concurrentPeak = 0;
let inFlight = 0;
let providerConcurrency: number;

function adapter(): ProviderAdapter {
  return {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(req) {
      return (async function* () {
        inFlight += 1;
        concurrentPeak = Math.max(concurrentPeak, inFlight);
        try {
          const result = behaviour(req.prompt);
          if (result.delayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, result.delayMs));
          } else {
            await Promise.resolve();
          }
          if (result.throws !== undefined) throw result.throws;
          yield { type: 'text' as const, delta: result.text ?? 'ok' };
          yield { type: 'usage' as const, tokensIn: 2, tokensOut: 3 };
          yield { type: 'finish' as const, reason: 'stop' as const };
        } finally {
          inFlight -= 1;
        }
      })();
    },
  };
}

const router: ModelRouter = {
  resolve: (node) =>
    node.modelId === 'scripted'
      ? { ok: true, route: { providerId: PROVIDER_ID, modelId: 'scripted', viaFallback: false } }
      : { ok: false, code: 'unavailable_model', reason: `no ${String(node.modelId)}` },
  resolveForBench: (node) =>
    node.routing.policy === 'fixed'
      ? { ok: true, route: { providerId: PROVIDER_ID, modelId: 'scripted', viaFallback: false } }
      : { ok: false, code: 'policy_not_allowed', reason: 'bench is fixed only' },
};

interface Harness {
  service: RunService;
  repository: FakeRepository;
  bus: EventBus;
  events: EngineEvent[];
  seed: (nodes: Node[], edges: Edge[]) => Promise<void>;
}

let harness: Harness;

async function build(concurrency = 20): Promise<Harness> {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  await repository.providers.create(scope, provider);
  await repository.models.replaceForProvider(scope, PROVIDER_ID, [model]);
  await repository.settings.update(scope, { dataDir: '/tmp/ace', concurrency });

  const gate = { inFlight: 0 };
  const service = createRunService({
    repository,
    scope,
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => NOW,
    router,
    adapterFor: async () => adapter(),
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    runGated: async (_providerId, fn) => {
      // A crude per-provider gate, so the scheduler's own limit can be told apart from it.
      while (gate.inFlight >= providerConcurrency) await new Promise((r) => setTimeout(r, 1));
      gate.inFlight += 1;
      try {
        return await fn();
      } finally {
        gate.inFlight -= 1;
      }
    },
    tokenBatchMs: 0,
  });

  return {
    service,
    repository,
    bus,
    events,
    async seed(nodes, edges) {
      await repository.workflows.create(scope, {
        id: workflowId,
        projectId: '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC',
        name: 'Flow',
        version: 3,
        formatVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      for (const node of nodes) await repository.nodes.insert(scope, node);
      for (const item of edges) await repository.edges.insert(scope, item);
    },
  };
}

const statesOf = (events: EngineEvent[], nodeId: string): NodeState[] =>
  events
    .filter((event) => event.type === 'node.state')
    .map((event) => event.payload as { nodeId: string; status: NodeState })
    .filter((payload) => payload.nodeId === nodeId)
    .map((payload) => payload.status);

beforeEach(async () => {
  workflowId = newId();
  behaviour = () => ({ text: 'ok' });
  concurrentPeak = 0;
  inFlight = 0;
  providerConcurrency = 20;
  harness = await build();
});

/* -------------------------------------------------------------------------- */
/* A linear run                                                                */
/* -------------------------------------------------------------------------- */

describe('TC-EXE-001 a linear workflow runs to COMPLETE', () => {
  async function linear(): Promise<Run> {
    const input = inputNode();
    const agent = agentNode();
    const output = outputNode();
    await harness.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    return harness.service.startRun(workflowId, {});
  }

  it('completes, with the output node holding the final text', async () => {
    behaviour = () => ({ text: 'the answer' });

    const run = await linear();

    expect(run.status).toBe('COMPLETE');
    expect(Object.values(run.finalOutput ?? {})).toEqual([[{ type: 'text', text: 'the answer' }]]);
  });

  it('BR-04 freezes the graph version and the nodes it ran', async () => {
    const run = await linear();

    expect(run.snapshot.version).toBe(3);
    expect(run.snapshot.nodes).toHaveLength(3);
    expect(run.snapshot.edges).toHaveLength(2);
  });

  it('records a node run per node', async () => {
    const run = await linear();

    const nodeRuns = await harness.repository.nodeRuns.listByRun(scope, run.id);
    expect(nodeRuns).toHaveLength(3);
    expect(nodeRuns.every((nodeRun) => nodeRun.status === 'COMPLETED')).toBe(true);
  });

  it('walks each node through IDLE, READY, RUNNING, COMPLETED', async () => {
    const run = await linear();
    const agentNodeRun = (await harness.repository.nodeRuns.listByRun(scope, run.id))[1]!;

    expect(statesOf(harness.events, agentNodeRun.nodeId)).toEqual(['READY', 'RUNNING', 'COMPLETED']);
  });

  it('FR-EXE-015 announces each transfer with a short summary', async () => {
    await linear();

    const transfers = harness.events.filter((event) => event.type === 'edge.transfer');
    expect(transfers).toHaveLength(2);
    for (const transfer of transfers) {
      const payload = transfer.payload as { summary: string };
      expect(payload.summary.length).toBeLessThanOrEqual(120);
      expect(payload.summary.length).toBeGreaterThan(0);
    }
  });

  it('announces the run starting and ending', async () => {
    await linear();

    expect(harness.events.filter((e) => e.type === 'run.started')).toHaveLength(1);
    const completed = harness.events.filter((e) => e.type === 'run.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.payload).toMatchObject({ status: 'COMPLETE' });
  });

  it('TC-OBS-002 totals exactly the sum of the node runs', async () => {
    const run = await linear();
    const nodeRuns = await harness.repository.nodeRuns.listByRun(scope, run.id);

    const sum = nodeRuns.reduce((total, nodeRun) => total + nodeRun.usage.tokensOut, 0);
    expect(run.totals.tokensOut).toBe(sum);
    expect(run.totals.tokensIn).toBe(
      nodeRuns.reduce((total, nodeRun) => total + nodeRun.usage.tokensIn, 0),
    );
  });

  it('emits usage.updated as the run goes', async () => {
    await linear();

    expect(harness.events.filter((e) => e.type === 'usage.updated').length).toBeGreaterThan(0);
  });
});

describe('TC-OBS-003 a new price table does not change an old run', () => {
  it('keeps the old run on the price it ran at, and prices the next run at the new one', async () => {
    const input = inputNode();
    const agent = agentNode();
    const output = outputNode();
    await harness.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const before = await harness.service.startRun(workflowId, {});
    const beforeNodeRuns = await harness.repository.nodeRuns.listByRun(scope, before.id);
    expect(before.totals.priceTableVersion).toBe('mock-v1');
    expect(before.totals.costUsd).toBeGreaterThan(0);

    // The catalog moves to a price table ten times dearer.
    await harness.repository.models.replaceForProvider(scope, PROVIDER_ID, [
      {
        ...model,
        pricing: { inputPer1k: 0.01, outputPer1k: 0.02, priceTableVersion: 'mock-v2' },
      },
    ]);
    const after = await harness.service.startRun(workflowId, {});

    expect(after.totals.priceTableVersion).toBe('mock-v2');
    expect(after.totals.costUsd).toBeCloseTo(before.totals.costUsd * 10, 10);

    // "View old run": the stored run and its node runs still say what they said.
    const old = await harness.service.getRun(before.id);
    expect(old.totals).toEqual(before.totals);
    expect(await harness.repository.nodeRuns.listByRun(scope, before.id)).toEqual(beforeNodeRuns);
  });
});

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

describe('TC-EXE-004 a node waits for every input it needs', () => {
  it('starts a join node only after both upstreams have delivered', async () => {
    const input = inputNode();
    const a = agentNode('A');
    const b = agentNode('B');
    const join = joinAgent('Join');
    const output = outputNode();

    await harness.seed(
      [input, a, b, join, output],
      [edge(input, a), edge(input, b), edge(a, join), edge(b, join), edge(join, output)],
    );

    const run = await harness.service.startRun(workflowId, {});
    expect(run.status).toBe('COMPLETE');

    const dispatched = harness.events
      .filter((event) => event.type === 'node.state')
      .map((event) => event.payload as { nodeId: string; status: NodeState })
      .filter((payload) => payload.status === 'RUNNING')
      .map((payload) => payload.nodeId);

    expect(dispatched.indexOf(join.id)).toBeGreaterThan(dispatched.indexOf(a.id));
    expect(dispatched.indexOf(join.id)).toBeGreaterThan(dispatched.indexOf(b.id));
  });

  it('gives the join node both upstream outputs to read', async () => {
    const input = inputNode();
    const a = agentNode('A');
    const b = agentNode('B');
    const join = joinAgent('Join');
    const output = outputNode();
    behaviour = (prompt) => ({ text: prompt.includes('Act as A') ? 'from A' : prompt.includes('Act as B') ? 'from B' : 'joined' });

    await harness.seed(
      [input, a, b, join, output],
      [edge(input, a), edge(input, b), edge(a, join), edge(b, join), edge(join, output)],
    );
    const run = await harness.service.startRun(workflowId, {});

    const joinRun = (await harness.repository.nodeRuns.listByRun(scope, run.id)).find(
      (nodeRun) => nodeRun.nodeId === join.id,
    );
    expect(joinRun?.inputEnvelopes).toHaveLength(2);
  });

  it('runs independent branches at the same time', async () => {
    const input = inputNode();
    const a = agentNode('A');
    const b = agentNode('B');
    const output = outputNode();
    behaviour = () => ({ text: 'ok', delayMs: 15 });

    await harness.seed([input, a, b, output], [edge(input, a), edge(input, b), edge(a, output)]);
    await harness.service.startRun(workflowId, {});

    expect(concurrentPeak).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

describe('TC-EXE-010 a failure halts the run', () => {
  it('halts with reason failure when the Output node never completes', async () => {
    const input = inputNode();
    const agent = agentNode();
    const output = outputNode();
    behaviour = () => ({
      throws: Object.assign(new Error('down'), {
        nodeError: { kind: 'provider', code: 'http_503', message: 'down', retryable: true },
      }),
    });

    await harness.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    const run = await harness.service.startRun(workflowId, {});

    expect(run.status).toBe('HALTED');
    expect(run.haltReason).toBe('failure');
  });

  it('FR-ERR-006 marks the unreachable downstream nodes BLOCKED', async () => {
    const input = inputNode();
    const agent = agentNode();
    const output = outputNode();
    behaviour = () => ({
      throws: Object.assign(new Error('down'), {
        nodeError: { kind: 'provider', code: 'http_503', message: 'down', retryable: true },
      }),
    });

    await harness.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    const run = await harness.service.startRun(workflowId, {});

    const nodeRuns = await harness.repository.nodeRuns.listByRun(scope, run.id);
    const outputRun = nodeRuns.find((nodeRun) => nodeRun.nodeId === output.id);
    expect(outputRun?.status).toBe('BLOCKED');
    expect(outputRun?.failureReason).toBe('BLOCKED');
  });

  it('lets an independent branch finish even though another failed', async () => {
    const input = inputNode();
    const bad = agentNode('Bad');
    const good = agentNode('Good');
    const output = outputNode();
    behaviour = (prompt) =>
      prompt.includes('Act as Bad')
        ? {
            throws: Object.assign(new Error('down'), {
              nodeError: { kind: 'provider', code: 'http_503', message: 'down', retryable: true },
            }),
          }
        : { text: 'fine' };

    await harness.seed(
      [input, bad, good, output],
      [edge(input, bad), edge(input, good), edge(good, output)],
    );
    const run = await harness.service.startRun(workflowId, {});

    const nodeRuns = await harness.repository.nodeRuns.listByRun(scope, run.id);
    expect(nodeRuns.find((nodeRun) => nodeRun.nodeId === good.id)?.status).toBe('COMPLETED');
    expect(nodeRuns.find((nodeRun) => nodeRun.nodeId === output.id)?.status).toBe('COMPLETED');
    // Every Output node completed, so the run completed — one dead branch is not a halt.
    expect(run.status).toBe('COMPLETE');
  });
});

/* -------------------------------------------------------------------------- */
/* Pre-flight                                                                  */
/* -------------------------------------------------------------------------- */

describe('TC-EXE-003 a blocked pre-flight is still a recorded run', () => {
  it('records the run as BLOCKED with its issues and calls no provider', async () => {
    const input = inputNode();
    const agent = agentNode('Agent', { modelId: undefined });
    const output = outputNode();
    let generated = 0;
    behaviour = () => {
      generated += 1;
      return { text: 'should never happen' };
    };

    await harness.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    const run = await harness.service.startRun(workflowId, {});

    expect(run.status).toBe('BLOCKED');
    expect(run.preflightIssues.length).toBeGreaterThan(0);
    expect(generated).toBe(0);
  });

  it('BR-08 still freezes the snapshot, so a blocked run is inspectable', async () => {
    const input = inputNode();
    const agent = agentNode('Agent', { modelId: undefined });
    await harness.seed([input, agent], [edge(input, agent)]);

    const run = await harness.service.startRun(workflowId, {});

    expect(run.snapshot.nodes).toHaveLength(2);
    expect(await harness.repository.runs.get(scope, run.id)).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Starting a run does not wait for its end                                    */
/* -------------------------------------------------------------------------- */

describe('FR-EXE-008 beginRun answers while the run is still going (D65)', () => {
  it('returns RUNNING with the provider call still in flight, and done settles COMPLETE', async () => {
    const input = inputNode();
    const agent = agentNode();
    const output = outputNode();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    behaviour = () => {
      calls += 1;
      return { text: 'late' };
    };
    const base = adapter();
    await harness.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    const generate = base.generate.bind(base);
    base.generate = (req, signal) =>
      (async function* () {
        await held;
        yield* generate(req, signal);
      })();
    const service = createRunService({
      repository: harness.repository,
      scope,
      bus: harness.bus,
      logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
      now: () => NOW,
      router,
      adapterFor: async () => base,
      checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
      runGated: async (_providerId, fn) => fn(),
      tokenBatchMs: 0,
    });

    const { run, done } = await service.beginRun(workflowId, {});

    expect(run.status).toBe('RUNNING');
    expect(run.endedAt).toBeUndefined();
    expect(calls).toBe(0);
    expect(service.activeRunCount()).toBe(1);

    release();
    const finished = await done;

    expect(finished.status).toBe('COMPLETE');
    expect(finished.id).toBe(run.id);
    expect(service.activeRunCount()).toBe(0);
  });

  it('returns a pre-flight-blocked run as BLOCKED, with done already settled', async () => {
    const input = inputNode();
    const agent = agentNode('Agent', { modelId: undefined });
    await harness.seed([input, agent], [edge(input, agent)]);

    const { run, done } = await harness.service.beginRun(workflowId, {});

    expect(run.status).toBe('BLOCKED');
    expect(run.preflightIssues.length).toBeGreaterThan(0);
    expect((await done).status).toBe('BLOCKED');
  });
});

/* -------------------------------------------------------------------------- */
/* Snapshot immutability                                                       */
/* -------------------------------------------------------------------------- */

describe('TC-NODE-008 a run uses its snapshot, not the live graph', () => {
  it('TC-EXE-002 runs a node that was deleted while the run was going', async () => {
    const input = inputNode();
    const agent = agentNode();
    const output = outputNode();
    behaviour = () => ({ text: 'ok', delayMs: 20 });
    await harness.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const started = harness.service.startRun(workflowId, {});

    // Wait until the run is genuinely under way before touching the live graph, so the test
    // asserts "deleted mid-run" rather than racing the snapshot.
    while (!harness.events.some((event) => event.type === 'node.state')) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await harness.repository.nodes.delete(scope, agent.id);
    await harness.repository.edges.deleteByNode(scope, agent.id);

    const run = await started;

    expect(run.status).toBe('COMPLETE');
    expect(run.snapshot.nodes.map((node) => node.id)).toContain(agent.id);
    expect(await harness.repository.nodes.listByWorkflow(scope, workflowId)).toHaveLength(2);
  });

  it('keeps the snapshot when the live graph is edited afterwards', async () => {
    const input = inputNode();
    const agent = agentNode();
    const output = outputNode();
    await harness.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    const run = await harness.service.startRun(workflowId, {});

    await harness.repository.nodes.update(scope, { ...agent, name: 'Renamed' });

    const stored = await harness.repository.runs.get(scope, run.id);
    expect(stored?.snapshot.nodes.find((node) => node.id === agent.id)?.name).toBe('Agent');
  });
});

/* -------------------------------------------------------------------------- */
/* Inputs and history                                                          */
/* -------------------------------------------------------------------------- */

describe('FR-NODE-011 inputs supplied at start', () => {
  it('uses the text from the request over the config', async () => {
    const input = inputNode('Brief', 'the stale config text');
    const output = outputNode();
    await harness.seed([input, output], [edge(input, output)]);

    const parts: Part[] = [{ type: 'text', text: 'typed into the dialog' }];
    const run = await harness.service.startRun(workflowId, { inputs: { [input.id]: parts } });

    expect(Object.values(run.finalOutput ?? {})).toEqual([parts]);
  });
});

describe('TC-EXE-011 run history', () => {
  it('lists the runs of a workflow newest first', async () => {
    const input = inputNode();
    const output = outputNode();
    await harness.seed([input, output], [edge(input, output)]);

    const first = await harness.service.startRun(workflowId, {});
    const second = await harness.service.startRun(workflowId, {});

    const page = await harness.service.listRuns(workflowId, { limit: 50 });
    expect(page.items.map((summary) => summary.id)).toEqual([second.id, first.id]);
  });

  it('summarises each run with what the history list shows', async () => {
    const input = inputNode();
    const output = outputNode();
    await harness.seed([input, output], [edge(input, output)]);
    await harness.service.startRun(workflowId, {});

    const [summary] = (await harness.service.listRuns(workflowId, { limit: 50 })).items;
    expect(summary).toMatchObject({ status: 'COMPLETE' });
    expect(summary?.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary).not.toHaveProperty('snapshot');
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                 */
/* -------------------------------------------------------------------------- */

describe('TC-PRV-009 / TC-NFR-005 concurrency limits are respected', () => {
  it('never runs more nodes at once than the provider allows', async () => {
    providerConcurrency = 2;
    harness = await build(20);

    const input = inputNode();
    const agents = [1, 2, 3, 4, 5].map((n) => agentNode(`A${n}`));
    const output = outputNode();
    behaviour = () => ({ text: 'ok', delayMs: 10 });

    await harness.seed(
      [input, ...agents, output],
      [...agents.map((agent) => edge(input, agent)), edge(agents[0]!, output)],
    );
    await harness.service.startRun(workflowId, {});

    expect(concurrentPeak).toBeLessThanOrEqual(2);
  });

  it('never runs more nodes at once than the engine setting allows', async () => {
    harness = await build(3);
    providerConcurrency = 99;

    const input = inputNode();
    const agents = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => agentNode(`A${n}`));
    const output = outputNode();
    behaviour = () => ({ text: 'ok', delayMs: 10 });

    await harness.seed(
      [input, ...agents, output],
      [...agents.map((agent) => edge(input, agent)), edge(agents[0]!, output)],
    );
    await harness.service.startRun(workflowId, {});

    expect(concurrentPeak).toBeLessThanOrEqual(3);
  });

  it('TC-NFR-005 runs twenty nodes concurrently without an error', async () => {
    harness = await build(20);
    providerConcurrency = 20;

    const input = inputNode();
    const agents = Array.from({ length: 20 }, (_unused, index) => agentNode(`A${index}`));
    const output = outputNode();

    await harness.seed(
      [input, ...agents, output],
      [...agents.map((agent) => edge(input, agent)), edge(agents[0]!, output)],
    );
    const run = await harness.service.startRun(workflowId, {});

    expect(run.status).toBe('COMPLETE');
    const nodeRuns = await harness.repository.nodeRuns.listByRun(scope, run.id);
    expect(nodeRuns.filter((nodeRun) => nodeRun.status === 'COMPLETED')).toHaveLength(22);
  });
});
