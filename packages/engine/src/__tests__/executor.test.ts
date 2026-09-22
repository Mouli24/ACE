import {
  AgentConfigSchema,
  type Envelope,
  type Model,
  type Node,
  type Part,
} from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createEventBus, type EventBus } from '../events/index.js';
import { createLogger } from '../logging/index.js';
import type { EngineEvent, ModelRouter, ProviderAdapter, StreamChunk } from '../ports/index.js';
import { LOCAL_SCOPE } from '../ports/index.js';
import { createNodeExecutor, type NodeExecutor } from '../runs/executor.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

const scope = LOCAL_SCOPE;
const NOW = '2026-09-22T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const UPSTREAM = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const agentNode = (config: Record<string, unknown> = {}): Node => ({
  id: NODE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'agent',
  name: 'Writer',
  position: { x: 0, y: 0 },
  inputs: [{ id: `${NODE_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${NODE_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    instructions: 'Summarise the brief.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    ...config,
  }),
});

const envelope = (reads: Part[] = [{ type: 'text', text: 'the brief' }]): Envelope => ({
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0ENVP',
  runId: RUN_ID,
  fromNodeId: UPSTREAM,
  toNodeId: NODE_ID,
  iteration: 1,
  reads,
  context: { budgetTokens: 4000, trust: 'untrusted' },
  contract: { outputTypes: ['text'] },
  createdAt: NOW,
});

const model = (overrides: Partial<Model> = {}): Model => ({
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
  pricing: { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
  ...overrides,
});

/** An adapter that plays back whatever chunks the test hands it. */
function scriptedAdapter(script: StreamChunk[] | (() => AsyncGenerator<StreamChunk>)) {
  const prompts: string[] = [];
  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(req) {
      prompts.push(req.prompt);
      if (typeof script === 'function') return script();
      return (async function* () {
        for (const chunk of script) yield chunk;
      })();
    },
  };
  return { adapter, prompts };
}

/**
 * A router stub. The real routing rules are `@ace/providers`' job and are tested there; what an
 * executor test cares about is that whatever the router decides is honoured and recorded.
 */
function stubRouter(models: Model[], override?: ModelRouter['resolve']): ModelRouter {
  const resolve: ModelRouter['resolve'] =
    override ??
    ((node) => {
      const row = models.find(
        (model) => model.modelId === node.modelId && model.providerId === node.providerId,
      );
      return row === undefined || !row.available
        ? { ok: false, code: 'unavailable_model', reason: `no ${String(node.modelId)}` }
        : { ok: true, route: { providerId: row.providerId, modelId: row.modelId, viaFallback: false } };
    });

  return { resolve, resolveForBench: resolve };
}

interface Harness {
  executor: NodeExecutor;
  bus: EventBus;
  events: EngineEvent[];
  prompts: string[];
}

let adapterScript: StreamChunk[] | (() => AsyncGenerator<StreamChunk>);
let models: Model[];
let routerOverride: ModelRouter['resolve'] | undefined;
let harness: Harness;

async function build(): Promise<Harness> {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  const { adapter, prompts } = scriptedAdapter(adapterScript);

  const executor = createNodeExecutor({
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => NOW,
    adapterFor: async () => adapter,
    modelsFor: async () => models,
    router: stubRouter(models, routerOverride),
    // No gate in these tests: concurrency is asserted in the scheduler and semaphore suites.
    runGated: async (_providerId, fn) => fn(),
    // Batch immediately, so a test does not wait out the 50 ms window.
    tokenBatchMs: 0,
  });

  return { executor, bus, events, prompts };
}

const run = (node: Node = agentNode(), envelopes: Envelope[] = [envelope()]) =>
  harness.executor.execute({
    runId: RUN_ID,
    workflowId: WORKFLOW_ID,
    nodeRunId: NODE_RUN_ID,
    node,
    envelopes,
    iteration: 1,
    attempt: 1,
    runInputs: {},
    signal: new AbortController().signal,
  });

const textChunks = (text: string): StreamChunk[] => [
  ...text.split(' ').map((word) => ({ type: 'text' as const, delta: `${word} ` })),
  { type: 'usage' as const, tokensIn: 2, tokensOut: text.split(' ').length },
  { type: 'finish' as const, reason: 'stop' as const },
];

beforeEach(async () => {
  adapterScript = textChunks('a clear and useful answer');
  models = [model()];
  routerOverride = undefined;
  harness = await build();
});

/* -------------------------------------------------------------------------- */
/* Agent nodes                                                                 */
/* -------------------------------------------------------------------------- */

describe('TC-EXE-001 an agent node produces its output', () => {
  it('completes with the streamed text as one part', async () => {
    const outcome = await run();

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'text', text: 'a clear and useful answer' }]);
  });

  it('sends the assembled prompt, with the brief in it', async () => {
    await run();

    expect(harness.prompts[0]).toContain('the brief');
    expect(harness.prompts[0]).toContain('Summarise the brief.');
  });

  it('FR-PRM-004 records the prompt and its version on the node run', async () => {
    const outcome = await run();

    expect(outcome.prompt?.version).toMatch(/^[0-9a-f]{12}$/);
    expect(outcome.prompt?.text).toContain('## System');
  });

  it('FR-RTR-006 records the model it actually used', async () => {
    const outcome = await run();

    expect(outcome.modelUsed).toEqual({
      providerId: PROVIDER_ID,
      modelId: 'scripted',
      viaFallback: false,
    });
  });

  it('FR-OBS-002 prices the call from the model price table', async () => {
    const outcome = await run();

    expect(outcome.usage.tokensIn).toBe(2);
    expect(outcome.usage.tokensOut).toBe(5);
    expect(outcome.usage.priceTableVersion).toBe('mock-v1');
    expect(outcome.usage.costUsd).toBeCloseTo((2 / 1000) * 0.001 + (5 / 1000) * 0.002, 12);
  });
});

describe('TC-EXE-007 output streams as it is generated', () => {
  it('emits node.token frames while the model is still answering', async () => {
    await run();

    const tokens = harness.events.filter((event) => event.type === 'node.token');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.map((event) => (event.payload as { delta: string }).delta).join('')).toBe(
      'a clear and useful answer ',
    );
  });

  it('§2.4 never persists a token frame, and never gives it a seq', async () => {
    await run();

    const tokens = harness.events.filter((event) => event.type === 'node.token');
    expect(tokens.every((event) => event.transient === true)).toBe(true);
  });

  it('addresses each token frame to its node run', async () => {
    await run();

    const token = harness.events.find((event) => event.type === 'node.token');
    expect(token?.payload).toMatchObject({ runId: RUN_ID, nodeRunId: NODE_RUN_ID });
  });

  it('emits node.output once, at the end, with the whole answer', async () => {
    await run();

    const outputs = harness.events.filter((event) => event.type === 'node.output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.payload).toMatchObject({
      nodeId: NODE_ID,
      output: [{ type: 'text', text: 'a clear and useful answer' }],
    });
  });

  it('routes run events to the workflow, so a workflow subscription receives them', async () => {
    await run();

    expect(harness.events.every((event) => event.workflowId === WORKFLOW_ID)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Contracts                                                                   */
/* -------------------------------------------------------------------------- */

describe('TC-EXE-005 output is checked against the contract', () => {
  it('parses json output when the contract asks for json', async () => {
    adapterScript = [
      { type: 'text', delta: '{"verdict":"approved","score":8}' },
      { type: 'usage', tokensIn: 2, tokensOut: 9 },
      { type: 'finish', reason: 'stop' },
    ];
    harness = await build();

    const outcome = await run(agentNode({ outputTypes: ['json'] }));

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'json', value: { verdict: 'approved', score: 8 } }]);
  });

  it('takes a json chunk directly when the adapter produced one', async () => {
    adapterScript = [
      { type: 'json', value: { verdict: 'approved' } },
      { type: 'usage', tokensIn: 1, tokensOut: 3 },
      { type: 'finish', reason: 'stop' },
    ];
    harness = await build();

    const outcome = await run(agentNode({ outputTypes: ['json'] }));

    expect(outcome.output).toEqual([{ type: 'json', value: { verdict: 'approved' } }]);
  });

  it('BR-03 fails with CONTRACT_VIOLATION, not RUN_FAILED, on malformed json', async () => {
    adapterScript = [
      { type: 'text', delta: '{ "oops": ' },
      { type: 'usage', tokensIn: 1, tokensOut: 3 },
      { type: 'finish', reason: 'stop' },
    ];
    harness = await build();

    const outcome = await run(agentNode({ outputTypes: ['json'] }));

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('CONTRACT_VIOLATION');
    expect(outcome.error?.kind).toBe('agent');
  });

  it('fails with CONTRACT_VIOLATION when json does not match the schema', async () => {
    adapterScript = [
      { type: 'text', delta: '{"verdict":"approved"}' },
      { type: 'usage', tokensIn: 1, tokensOut: 3 },
      { type: 'finish', reason: 'stop' },
    ];
    harness = await build();

    const outcome = await run(
      agentNode({
        outputTypes: ['json'],
        outputContract: { jsonSchema: { type: 'object', required: ['verdict', 'score'] } },
      }),
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('CONTRACT_VIOLATION');
    expect(outcome.error?.message).toContain('score');
  });

  it('emits node.error rather than node.output when the contract fails', async () => {
    adapterScript = [
      { type: 'text', delta: 'not json at all' },
      { type: 'usage', tokensIn: 1, tokensOut: 3 },
      { type: 'finish', reason: 'stop' },
    ];
    harness = await build();

    await run(agentNode({ outputTypes: ['json'] }));

    expect(harness.events.some((event) => event.type === 'node.error')).toBe(true);
    expect(harness.events.some((event) => event.type === 'node.output')).toBe(false);
  });

  it('still records what the call cost, because a violated contract was still paid for', async () => {
    adapterScript = [
      { type: 'text', delta: 'not json' },
      { type: 'usage', tokensIn: 4, tokensOut: 2 },
      { type: 'finish', reason: 'stop' },
    ];
    harness = await build();

    expect((await run(agentNode({ outputTypes: ['json'] }))).usage.tokensIn).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

describe('Arch §28 a provider failure fails the node run', () => {
  it('reports RUN_FAILED with the provider error kind', async () => {
    // A stream that throws before its first chunk: an adapter that could not even start.
    adapterScript = () =>
      (async function* (): AsyncGenerator<StreamChunk> {
        await Promise.resolve();
        throw Object.assign(new Error('down'), {
          nodeError: { kind: 'provider', code: 'http_503', message: 'down', retryable: true },
        });
        yield { type: 'finish', reason: 'stop' };
      })();
    harness = await build();

    const outcome = await run();

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('RUN_FAILED');
    expect(outcome.error?.kind).toBe('provider');
  });

  it('TC-NODE-007 fails when the router has no model to offer', async () => {
    models = [];
    harness = await build();

    const outcome = await run();

    expect(outcome.status).toBe('FAILED');
    expect(outcome.error?.kind).toBe('invalid_config');
  });

  it('FR-RTR-006 records the fallback the router chose, flagged as one', async () => {
    models = [model({ id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE2', modelId: 'backup' })];
    routerOverride = () => ({
      ok: true,
      route: { providerId: PROVIDER_ID, modelId: 'backup', viaFallback: true },
    });
    harness = await build();

    const outcome = await run(
      agentNode({ routing: { policy: 'fallback', fallbackModelIds: ['backup'] } }),
    );

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.modelUsed).toEqual({
      providerId: PROVIDER_ID,
      modelId: 'backup',
      viaFallback: true,
    });
  });

  it('reports a refusal as an agent error (§2.6 mock-refuse)', async () => {
    adapterScript = [
      { type: 'text', delta: 'I cannot help with that.' },
      { type: 'usage', tokensIn: 1, tokensOut: 5 },
      { type: 'finish', reason: 'refusal' },
    ];
    harness = await build();

    const outcome = await run();

    expect(outcome.status).toBe('FAILED');
    expect(outcome.error?.kind).toBe('agent');
    expect(outcome.failureReason).toBe('RUN_FAILED');
  });
});

/* -------------------------------------------------------------------------- */
/* Other node kinds                                                            */
/* -------------------------------------------------------------------------- */

describe('FR-EXE-004 the other node kinds run without a provider', () => {
  const inputNode = (text: string): Node => ({
    id: NODE_ID,
    workflowId: WORKFLOW_ID,
    kind: 'input',
    name: 'Brief',
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: [{ id: `${NODE_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
    config: { text, artifactIds: [], outputTypes: ['text'] },
  });

  it('an Input node produces what it was configured with', async () => {
    const outcome = await run(inputNode('typed by the user'), []);

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'text', text: 'typed by the user' }]);
  });

  it('FR-NODE-011 an Input node prefers what was supplied at start', async () => {
    const outcome = await harness.executor.execute({
      runId: RUN_ID,
      workflowId: WORKFLOW_ID,
      nodeRunId: NODE_RUN_ID,
      node: inputNode('the stale config text'),
      envelopes: [],
      iteration: 1,
      attempt: 1,
      runInputs: { [NODE_ID]: [{ type: 'text', text: 'typed into the dialog' }] },
      signal: new AbortController().signal,
    });

    expect(outcome.output).toEqual([{ type: 'text', text: 'typed into the dialog' }]);
  });

  it('an Input node costs nothing', async () => {
    const outcome = await run(inputNode('x'), []);

    expect(outcome.usage).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });

  it('FR-NODE-013 a transform node reshapes its reads', async () => {
    const transform: Node = {
      id: NODE_ID,
      workflowId: WORKFLOW_ID,
      kind: 'transform',
      name: 'Extract',
      position: { x: 0, y: 0 },
      inputs: [{ id: `${NODE_ID}:in:in`, name: 'in', dataType: 'json', multi: false }],
      outputs: [{ id: `${NODE_ID}:out:out`, name: 'out', dataType: 'json', multi: true }],
      config: { op: 'extract_json_field', path: 'review.score' },
    };

    const outcome = await run(transform, [envelope([{ type: 'json', value: { review: { score: 8 } } }])]);

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'json', value: 8 }]);
  });

  it('a transform that cannot do its job fails with a workflow error', async () => {
    const transform: Node = {
      id: NODE_ID,
      workflowId: WORKFLOW_ID,
      kind: 'transform',
      name: 'Extract',
      position: { x: 0, y: 0 },
      inputs: [],
      outputs: [],
      config: { op: 'extract_json_field', path: 'nothing.here' },
    };

    const outcome = await run(transform, [envelope([{ type: 'json', value: {} }])]);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.error?.kind).toBe('workflow');
  });

  it('an Output node passes its reads through as the final result', async () => {
    const output: Node = {
      id: NODE_ID,
      workflowId: WORKFLOW_ID,
      kind: 'output',
      name: 'Result',
      position: { x: 0, y: 0 },
      inputs: [{ id: `${NODE_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
      outputs: [],
      config: {},
    };

    const outcome = await run(output, [envelope([{ type: 'text', text: 'the answer' }])]);

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'text', text: 'the answer' }]);
  });
});

describe('FR-EXE-010 cancellation', () => {
  it('reports a cancelled call as user_cancelled rather than a failure of the model', async () => {
    const controller = new AbortController();
    adapterScript = () =>
      (async function* (): AsyncGenerator<StreamChunk> {
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        yield { type: 'finish', reason: 'stop' };
      })();
    harness = await build();

    const outcome = await harness.executor.execute({
      runId: RUN_ID,
      workflowId: WORKFLOW_ID,
      nodeRunId: NODE_RUN_ID,
      node: agentNode(),
      envelopes: [envelope()],
      iteration: 1,
      attempt: 1,
      runInputs: {},
      signal: controller.signal,
    });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.error?.kind).toBe('user_cancelled');
  });
});
