import { AgentConfigSchema, type Edge, type Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createEventBus } from '../events/index.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent, type ModelRouter, type ProviderAdapter } from '../ports/index.js';
import { createRunService } from '../runs/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

/**
 * NFR-PERF-03/04 and NFR-REL-01, measured rather than asserted by eye. Both tests print their
 * number, because the round report has to quote it (§4 "Done when").
 *
 * They run against an instant in-memory adapter, so what is being measured is the engine's own
 * dispatch and bookkeeping — not a provider.
 */

const scope = LOCAL_SCOPE;
const NOW = '2026-09-22T10:00:00.000Z';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

const port = (nodeId: string, dir: 'in' | 'out', name: string, multi = false) => ({
  id: `${nodeId}:${dir}:${name}`,
  name,
  dataType: 'text' as const,
  multi,
});

function buildHarness(workflowId: string, nodeCount: number) {
  const input: Node = (() => {
    const id = newId();
    return {
      id,
      workflowId,
      kind: 'input',
      name: 'Brief',
      position: { x: 0, y: 0 },
      inputs: [],
      outputs: [port(id, 'out', 'text', true)],
      config: { text: 'go', artifactIds: [], outputTypes: ['text'] },
    };
  })();

  const agents: Node[] = Array.from({ length: nodeCount }, (_unused, index) => {
    const id = newId();
    return {
      id,
      workflowId,
      kind: 'agent',
      name: `A${index}`,
      position: { x: 0, y: 0 },
      inputs: [port(id, 'in', 'text')],
      outputs: [port(id, 'out', 'text', true)],
      config: AgentConfigSchema.parse({
        providerId: PROVIDER_ID,
        modelId: 'instant',
        instructions: 'go',
        inputTypes: ['text'],
        outputTypes: ['text'],
      }),
    };
  });

  const output: Node = (() => {
    const id = newId();
    return {
      id,
      workflowId,
      kind: 'output',
      name: 'Result',
      position: { x: 0, y: 0 },
      inputs: [port(id, 'in', 'text')],
      outputs: [],
      config: {},
    };
  })();

  const edges: Edge[] = [
    ...agents.map(
      (agent): Edge => ({
        id: newId(),
        workflowId,
        kind: 'data',
        from: { nodeId: input.id, portId: input.outputs[0]!.id },
        to: { nodeId: agent.id, portId: agent.inputs[0]!.id },
      }),
    ),
    {
      id: newId(),
      workflowId,
      kind: 'data',
      from: { nodeId: agents[0]!.id, portId: agents[0]!.outputs[0]!.id },
      to: { nodeId: output.id, portId: output.inputs[0]!.id },
    },
  ];

  return { nodes: [input, ...agents, output], edges };
}

const instantAdapter = (): ProviderAdapter => ({
  type: 'mock',
  check: async () => ({ status: 'CONNECTED' }),
  listModels: async () => [],
  generate: () =>
    (async function* () {
      yield { type: 'text' as const, delta: 'ok' };
      yield { type: 'usage' as const, tokensIn: 1, tokensOut: 1 };
      yield { type: 'finish' as const, reason: 'stop' as const };
    })(),
});

const router: ModelRouter = {
  resolve: () => ({
    ok: true,
    route: { providerId: PROVIDER_ID, modelId: 'instant', viaFallback: false },
  }),
  resolveForBench: () => ({
    ok: true,
    route: { providerId: PROVIDER_ID, modelId: 'instant', viaFallback: false },
  }),
};

async function runGraph(nodeCount: number, concurrency: number) {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });

  await repository.providers.create(scope, {
    id: PROVIDER_ID,
    type: 'mock',
    name: 'Mock',
    keySet: false,
    status: 'CONNECTED',
    concurrency: 64,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repository.models.replaceForProvider(scope, PROVIDER_ID, [
    {
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
      providerId: PROVIDER_ID,
      modelId: 'instant',
      displayName: 'Instant',
      inputTypes: ['text'],
      outputTypes: ['text'],
      contextWindow: 200_000,
      supportsTools: false,
      supportsJson: false,
      available: true,
      source: 'discovered',
      lastCheckedAt: NOW,
    },
  ]);
  await repository.settings.update(scope, { dataDir: '/tmp/ace', concurrency });

  const workflowId = newId();
  await repository.workflows.create(scope, {
    id: workflowId,
    projectId: newId(),
    name: 'Perf',
    version: 1,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const { nodes, edges } = buildHarness(workflowId, nodeCount);
  for (const node of nodes) await repository.nodes.insert(scope, node);
  for (const edge of edges) await repository.edges.insert(scope, edge);

  const service = createRunService({
    repository,
    scope,
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => new Date().toISOString(),
    router,
    adapterFor: async () => instantAdapter(),
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
  });

  const startedAt = performance.now();
  const run = await service.startRun(workflowId, {});
  const elapsedMs = performance.now() - startedAt;

  return { run, elapsedMs, nodeCount: nodes.length, repository };
}

describe('TC-NFR-002 dispatch overhead stays under 50 ms per node', () => {
  it('runs 100 instant nodes and prints the per-node cost', async () => {
    const { run, elapsedMs, nodeCount, repository } = await runGraph(100, 20);

    const perNodeMs = elapsedMs / nodeCount;
    // eslint-disable-next-line no-console
    console.log(
      `TC-NFR-002: ${nodeCount} nodes in ${elapsedMs.toFixed(0)} ms = ${perNodeMs.toFixed(2)} ms per node`,
    );

    expect(run.status).toBe('COMPLETE');
    expect(await repository.nodeRuns.listByRun(scope, run.id)).toHaveLength(nodeCount);
    expect(perNodeMs).toBeLessThan(50);
  }, 60_000);
});

describe('TC-NFR-003 the first token reaches a subscriber well inside 200 ms', () => {
  it('measures the gap between the adapter yielding and the frame arriving', async () => {
    const repository = new FakeRepository();
    const pubsub = new InProcessPubSubStub<EngineEvent>();
    const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });

    let yieldedAt = 0;
    let firstFrameAt = 0;
    await bus.subscribe((event) => {
      if (event.type === 'node.token' && firstFrameAt === 0) firstFrameAt = performance.now();
    });

    const slow: ProviderAdapter = {
      type: 'mock',
      check: async () => ({ status: 'CONNECTED' }),
      listModels: async () => [],
      generate: () =>
        (async function* () {
          // §2.6 `mock-slow`: 100 words, 20 ms apart.
          for (let index = 0; index < 100; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (index === 0) yieldedAt = performance.now();
            yield { type: 'text' as const, delta: `word${index} ` };
          }
          yield { type: 'usage' as const, tokensIn: 1, tokensOut: 100 };
          yield { type: 'finish' as const, reason: 'stop' as const };
        })(),
    };

    await repository.providers.create(scope, {
      id: PROVIDER_ID,
      type: 'mock',
      name: 'Mock',
      keySet: false,
      status: 'CONNECTED',
      concurrency: 8,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await repository.models.replaceForProvider(scope, PROVIDER_ID, [
      {
        id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
        providerId: PROVIDER_ID,
        modelId: 'instant',
        displayName: 'Slow',
        inputTypes: ['text'],
        outputTypes: ['text'],
        contextWindow: 200_000,
        supportsTools: false,
        supportsJson: false,
        available: true,
        source: 'discovered',
        lastCheckedAt: NOW,
      },
    ]);
    await repository.settings.update(scope, { dataDir: '/tmp/ace', concurrency: 20 });

    const workflowId = newId();
    await repository.workflows.create(scope, {
      id: workflowId,
      projectId: newId(),
      name: 'Stream',
      version: 1,
      formatVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { nodes, edges } = buildHarness(workflowId, 1);
    for (const node of nodes) await repository.nodes.insert(scope, node);
    for (const edge of edges) await repository.edges.insert(scope, edge);

    const service = createRunService({
      repository,
      scope,
      bus,
      logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
      now: () => new Date().toISOString(),
      router,
      adapterFor: async () => slow,
      checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
      runGated: async (_providerId, fn) => fn(),
      // The real ~50 ms batching window of Arch §24, not an instant one.
    });

    const run = await service.startRun(workflowId, {});
    const latencyMs = firstFrameAt - yieldedAt;

    // eslint-disable-next-line no-console
    console.log(`TC-NFR-003: first node.token ${latencyMs.toFixed(1)} ms after the adapter yielded`);

    expect(run.status).toBe('COMPLETE');
    expect(firstFrameAt).toBeGreaterThan(0);
    expect(latencyMs).toBeLessThan(200);
  }, 60_000);
});

describe('TC-NFR-005 twenty concurrent node runs finish without an error', () => {
  it('runs them and prints the wall time', async () => {
    const { run, elapsedMs, repository } = await runGraph(20, 20);

    // eslint-disable-next-line no-console
    console.log(`TC-NFR-005: 22 nodes at concurrency 20 in ${elapsedMs.toFixed(0)} ms`);

    expect(run.status).toBe('COMPLETE');
    const nodeRuns = await repository.nodeRuns.listByRun(scope, run.id);
    expect(nodeRuns.every((nodeRun) => nodeRun.status === 'COMPLETED')).toBe(true);
    expect(nodeRuns.every((nodeRun) => nodeRun.error === undefined)).toBe(true);
  }, 60_000);
});
