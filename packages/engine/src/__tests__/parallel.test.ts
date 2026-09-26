import {
  AgentConfigSchema,
  REVIEW_CONTRACT_SCHEMA,
  derivePorts,
  type Edge,
  type Model,
  type Node,
  type Provider,
} from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createEventBus } from '../events/index.js';
import { newId } from '../ids.js';
import { exitConditionMet } from '../loops/index.js';
import { createLogger } from '../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type ModelRouter,
  type ProviderAdapter,
  type StreamChunk,
} from '../ports/index.js';
import { createNodeExecutor } from '../runs/executor.js';
import { createRunGateRegistry, createRunService, type RunService } from '../runs/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

/**
 * Independent branches and the review contract (FR-PAR-001, FR-PAR-007, TC-PAR-001, TC-PAR-008).
 *
 * Both are true of the engine *as it stands*: the scheduler already dispatches everything READY up
 * to the concurrency limit, and the executor already validates an output against its json schema.
 * They are tested here because neither had a test that would fail if the behaviour broke — a
 * diamond that quietly serialised, or a review with no verdict reported as RUN_FAILED rather than
 * CONTRACT_VIOLATION, would both have gone unnoticed (BR-03, D85).
 */

const NOW = '2026-09-26T10:00:00.000Z';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

/** What each branch's provider call costs: `mock-slow` is 100 words at 20 ms, ≈2 s (round 2 §2.6). */
const BRANCH_MS = 2000;

const silent = createLogger({ level: 'silent', destination: { write: () => undefined } });

let workflowId: string;

/* -------------------------------------------------------------------------- */
/* Graph                                                                      */
/* -------------------------------------------------------------------------- */

function inputNode(): Node {
  const id = newId();
  const config = { text: 'the brief', artifactIds: [], outputTypes: ['text' as const] };
  return {
    id,
    workflowId,
    kind: 'input',
    name: 'Brief',
    position: { x: 0, y: 0 },
    ...derivePorts({ id, kind: 'input', config }),
    config,
  };
}

function agentNode(
  name: string,
  outputTypes: ('text' | 'json')[] = ['text'],
  extra: Record<string, unknown> = {},
): Node {
  const id = newId();
  const config = AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    instructions: `Act as ${name}.`,
    inputTypes: ['text'],
    outputTypes,
    ...extra,
  });
  return {
    id,
    workflowId,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    ...derivePorts({ id, kind: 'agent', config }),
    config,
  };
}

function outputNode(): Node {
  const id = newId();
  return {
    id,
    workflowId,
    kind: 'output',
    name: 'Result',
    position: { x: 0, y: 0 },
    ...derivePorts({ id, kind: 'output', config: {} }),
    config: {},
  };
}

const edgeBetween = (from: Node, fromType: string, to: Node, toType: string): Edge => ({
  id: newId(),
  workflowId,
  kind: 'data',
  from: { nodeId: from.id, portId: `${from.id}:out:${fromType}` },
  to: { nodeId: to.id, portId: `${to.id}:in:${toType}` },
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
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
  outputTypes: ['text', 'json'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: true,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
};

const router: ModelRouter = {
  resolve: () => ({
    ok: true,
    route: { providerId: PROVIDER_ID, modelId: 'scripted', viaFallback: false },
  }),
  resolveForBench: () => ({
    ok: true,
    route: { providerId: PROVIDER_ID, modelId: 'scripted', viaFallback: false },
  }),
};

/** When each provider call began and ended, so overlap is measured rather than assumed. */
const spans: { startedAt: number; endedAt: number }[] = [];

function slowAdapter(): ProviderAdapter {
  return {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate() {
      return (async function* () {
        const startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, BRANCH_MS));
        spans.push({ startedAt, endedAt: Date.now() });
        yield { type: 'text' as const, delta: 'done' };
        yield { type: 'usage' as const, tokensIn: 2, tokensOut: 3 };
        yield { type: 'finish' as const, reason: 'stop' as const };
      })();
    },
  };
}

async function runService(
  adapter: ProviderAdapter,
  graph: { nodes: Node[]; edges: Edge[] },
): Promise<RunService> {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope: LOCAL_SCOPE, pubsub, now: () => NOW });

  await repository.providers.create(LOCAL_SCOPE, provider);
  await repository.models.replaceForProvider(LOCAL_SCOPE, PROVIDER_ID, [model]);
  await repository.settings.update(LOCAL_SCOPE, { dataDir: '/tmp/ace', concurrency: 20 });
  await repository.workflows.create(LOCAL_SCOPE, {
    id: workflowId,
    projectId: '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC',
    name: 'Flow',
    version: 1,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  for (const node of graph.nodes) await repository.nodes.insert(LOCAL_SCOPE, node);
  for (const edge of graph.edges) await repository.edges.insert(LOCAL_SCOPE, edge);

  return createRunService({
    gates: createRunGateRegistry(),
    repository,
    scope: LOCAL_SCOPE,
    bus,
    logger: silent,
    now: () => NOW,
    router,
    adapterFor: async () => adapter,
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
  });
}

beforeEach(() => {
  workflowId = newId();
  spans.length = 0;
});

/* -------------------------------------------------------------------------- */

describe('TC-PAR-001 Independent branches run at the same time', () => {
  /**
   * Two branches off one Input, each ending in its own Output node. They converge on a Merge node in
   * the §1 fixture; here they do not, because a merge cannot be executed until the wiring of §4
   * item 6 lands and an `output` node's ports are single-input by derivation (D18) — which is a
   * limit of what this test can reach, not of the scheduler. What it does reach is the only thing
   * FR-PAR-001 claims: the two provider calls are in flight at once.
   */
  it(
    `two ${BRANCH_MS} ms branches finish in about ${BRANCH_MS} ms, not twice that`,
    async () => {
      const input = inputNode();
      const left = agentNode('Left');
      const right = agentNode('Right');
      const leftOut = outputNode();
      const rightOut = outputNode();

      const service = await runService(slowAdapter(), {
        nodes: [input, left, right, leftOut, rightOut],
        edges: [
          edgeBetween(input, 'text', left, 'text'),
          edgeBetween(input, 'text', right, 'text'),
          edgeBetween(left, 'text', leftOut, 'text'),
          edgeBetween(right, 'text', rightOut, 'text'),
        ],
      });

      const startedAt = Date.now();
      const run = await service.startRun(workflowId, {});
      const elapsed = Date.now() - startedAt;

      expect(run.preflightIssues).toEqual([]);
      expect(run.status).toBe('COMPLETE');
      expect(spans).toHaveLength(2);

      // The measurement that matters, and the one no clock speed can fake: the two calls were both
      // in flight at the same moment.
      const [first, second] = [...spans].sort((a, b) => a.startedAt - b.startedAt);
      expect(first!.endedAt).toBeGreaterThan(second!.startedAt);

      // And the wall clock agrees — one branch's worth of time, not two.
      expect(elapsed).toBeLessThan(BRANCH_MS * 1.5);
    },
    BRANCH_MS * 5,
  );

  it('a node fed by two branches waits for both before it runs', async () => {
    const input = inputNode();
    const left = agentNode('Left');
    const right = agentNode('Right');
    const output = outputNode();

    // The Output node's text input takes one edge by derivation, so the second branch is wired to
    // its json input: two edges, two ports, one node that must wait for both.
    const service = await runService(
      {
        type: 'mock',
        check: async () => ({ status: 'CONNECTED' }),
        listModels: async () => [],
        generate() {
          return (async function* () {
            yield { type: 'text' as const, delta: 'done' };
            yield { type: 'finish' as const, reason: 'stop' as const };
          })();
        },
      },
      {
        nodes: [input, left, right, output],
        edges: [
          edgeBetween(input, 'text', left, 'text'),
          edgeBetween(input, 'text', right, 'text'),
          edgeBetween(left, 'text', output, 'text'),
          { ...edgeBetween(right, 'text', output, 'code'), to: { nodeId: output.id, portId: `${output.id}:in:code` } },
        ],
      },
    );

    const run = await service.startRun(workflowId, {});
    const nodeRuns = await service.listNodeRuns(run.id);

    expect(run.status).toBe('COMPLETE');
    expect(nodeRuns).toHaveLength(4);
    // One node run for the join, holding what both branches produced.
    const join = nodeRuns.filter((nodeRun) => nodeRun.nodeId === output.id);
    expect(join).toHaveLength(1);
    expect(join[0]?.output).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */

describe('TC-PAR-008 Bad review output', () => {
  function reviewerExecutor(chunks: StreamChunk[]) {
    const adapter: ProviderAdapter = {
      type: 'mock',
      check: async () => ({ status: 'CONNECTED' }),
      listModels: async () => [],
      generate() {
        return (async function* () {
          yield* chunks;
        })();
      },
    };

    return createNodeExecutor({
      bus: {
        emit: async (event) => ({ ...event, seq: 1, createdAt: NOW }) as EngineEvent,
        emitTransient: async () => undefined,
        subscribe: async () => () => undefined,
      },
      logger: silent,
      adapterFor: async () => adapter,
      modelsFor: async () => [model],
      runGated: async (_providerId, fn) => fn(),
      router,
      tokenBatchMs: 0,
    });
  }

  async function review(value: unknown) {
    const node = agentNode('Reviewer', ['json'], {
      outputContract: { jsonSchema: REVIEW_CONTRACT_SCHEMA },
    });

    return reviewerExecutor([
      { type: 'json', value },
      { type: 'usage', tokensIn: 2, tokensOut: 3 },
      { type: 'finish', reason: 'stop' },
    ]).execute({
      runId: newId(),
      workflowId,
      nodeRunId: newId(),
      node,
      envelopes: [],
      iteration: 1,
      attempt: 1,
      runInputs: {},
      signal: new AbortController().signal,
    });
  }

  it('a reviewer that returns no verdict is CONTRACT_VIOLATION, not RUN_FAILED', async () => {
    const outcome = await review({ score: 4, issues: ['needs work'] });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('CONTRACT_VIOLATION');
    expect(outcome.error?.message).toContain('verdict');
  });

  it.each([
    ['a verdict outside the enum', { score: 4, verdict: 'maybe', issues: [] }],
    ['a score above 10', { score: 11, verdict: 'approved', issues: [] }],
    ['issues that are not strings', { score: 4, verdict: 'approved', issues: [1] }],
  ])('%s is CONTRACT_VIOLATION too', async (_name, value) => {
    expect((await review(value)).failureReason).toBe('CONTRACT_VIOLATION');
  });

  it('a well-formed review passes, and its verdict is what the loop reads', async () => {
    const outcome = await review({ score: 9, verdict: 'approved', issues: [] });

    expect(outcome.status).toBe('COMPLETED');
    expect(
      exitConditionMet(
        {
          maxIterations: 3,
          exitCondition: { path: 'verdict', equals: 'approved' },
          onMax: 'continue',
        },
        outcome.output,
      ),
    ).toBe(true);
  });

  it('extra keys beside the contract are allowed — mock-reject-twice echoes its prompt', async () => {
    const outcome = await review({ score: 4, verdict: 'changes_requested', issues: [], echo: 'x' });
    expect(outcome.status).toBe('COMPLETED');
  });
});
