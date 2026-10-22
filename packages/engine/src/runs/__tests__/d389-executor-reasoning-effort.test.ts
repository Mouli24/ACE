/**
 * D389 Per-node reasoning effort reaches the provider (docs/research/pandacode-integration-plan.md
 * W1-5). The executor puts the node's `execution.reasoningEffort` on the GenerateRequest only when
 * it is set; unset or cleared (`null`), the request carries no such key and is what it always was.
 */
import { AgentConfigSchema, type Envelope, type Model, type Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createEventBus } from '../../events/index.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type GenerateRequest,
  type ModelRouter,
  type ProviderAdapter,
  type StreamChunk,
} from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createNodeExecutor } from '../executor.js';

const NOW = '2026-10-21T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN89';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NR89';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WF89';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PR89';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ND89';
const UPSTREAM = '01JBXQ8Z9KQ4R7N2VWXYZ0UP89';

const agent = (execution: Record<string, unknown> = {}): Node => ({
  id: NODE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'agent',
  name: 'Thinker',
  position: { x: 0, y: 0 },
  inputs: [{ id: `${NODE_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${NODE_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    instructions: 'Think it through.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    execution,
  }),
});

const envelope: Envelope = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0EN89',
  runId: RUN_ID,
  fromNodeId: UPSTREAM,
  toNodeId: NODE_ID,
  iteration: 1,
  reads: [{ type: 'text', text: 'the question' }],
  context: { budgetTokens: 4000, trust: 'untrusted' },
  contract: { outputTypes: ['text'] },
  createdAt: NOW,
};

const model: Model = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MD89',
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
};

/** Runs one node against a mock-typed adapter and returns every request it was sent. */
async function requestsFor(node: Node): Promise<GenerateRequest[]> {
  const repository = new FakeRepository();
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
    now: () => NOW,
  });
  const requests: GenerateRequest[] = [];
  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate: (req) => {
      requests.push(req);
      return (async function* (): AsyncGenerator<StreamChunk> {
        await Promise.resolve();
        yield { type: 'text', delta: 'Answered.' };
        yield { type: 'usage', tokensIn: 1, tokensOut: 1 };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  const route = { providerId: PROVIDER_ID, modelId: 'scripted', viaFallback: false };
  const router: ModelRouter = {
    resolve: () => ({ ok: true, route }),
    resolveForBench: () => ({ ok: true, route }),
  };
  const executor = createNodeExecutor({
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => NOW,
    adapterFor: async () => adapter,
    modelsFor: async () => [model],
    router,
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
  });
  const outcome = await executor.execute({
    runId: RUN_ID,
    workflowId: WORKFLOW_ID,
    nodeRunId: NODE_RUN_ID,
    node,
    envelopes: [envelope],
    iteration: 1,
    attempt: 1,
    runInputs: {},
    signal: new AbortController().signal,
  });
  expect(outcome.status).toBe('COMPLETED');
  return requests;
}

describe('D389 the executor passes the node’s reasoning effort', () => {
  it('a node set to high sends reasoningEffort high', async () => {
    const requests = await requestsFor(agent({ reasoningEffort: 'high' }));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.reasoningEffort).toBe('high');
  });

  it('max is passed as max: mapping it is each adapter’s job', async () => {
    const requests = await requestsFor(agent({ reasoningEffort: 'max' }));
    expect(requests[0]?.reasoningEffort).toBe('max');
  });

  it('an unset effort sends no key: the request is what it was before', async () => {
    const requests = await requestsFor(agent());
    expect(requests[0]).not.toHaveProperty('reasoningEffort');
  });

  it('a cleared (null) effort sends no key either', async () => {
    const requests = await requestsFor(agent({ reasoningEffort: null }));
    expect(requests[0]).not.toHaveProperty('reasoningEffort');
  });
});
