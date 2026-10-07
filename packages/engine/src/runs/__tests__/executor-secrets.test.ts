import {
  AgentConfigSchema,
  type Envelope,
  type Model,
  type Node,
  type ProviderType,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type GenerateRequest,
  type ModelRouter,
  type ProviderAdapter,
} from '../../ports/index.js';
import { createNodeExecutor, type ExecuteNodeInput } from '../executor.js';

/*
 * ACE parity P1 (D274): a CLI-route provider is handed the secrets in its run's project scope as
 * its process environment, and their names — only their names — in its prompt's `### Environment`.
 * An API or a local model runs nothing on this machine and gets neither.
 */

const NOW = '2026-10-07T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const UPSTREAM = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';

const ENV = { DEPLOY_TOKEN: 'fake-deploy-value-0001', API_URL: 'https://staging.example.test' };

const node: Node = {
  id: NODE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'agent',
  name: 'Builder',
  position: { x: 0, y: 0 },
  inputs: [{ id: `${NODE_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${NODE_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'sonnet',
    instructions: 'Deploy the branch.',
    inputTypes: ['text'],
    outputTypes: ['text'],
  }),
};

const model: Model = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'sonnet',
  displayName: 'Sonnet',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
};

const envelope: Envelope = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0ENVP',
  runId: RUN_ID,
  fromNodeId: UPSTREAM,
  toNodeId: NODE_ID,
  iteration: 1,
  reads: [{ type: 'text', text: 'the brief' }],
  context: { budgetTokens: 4000, trust: 'untrusted' },
  contract: { outputTypes: ['text'] },
  createdAt: NOW,
};

const route = {
  ok: true as const,
  route: { providerId: PROVIDER_ID, modelId: 'sonnet', viaFallback: false },
};
const router: ModelRouter = { resolve: () => route, resolveForBench: () => route };

async function run(
  type: ProviderType,
  envForRun?: () => Promise<Record<string, string> | undefined>,
) {
  const repository = new FakeRepository();
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
    now: () => NOW,
  });
  const requests: GenerateRequest[] = [];
  const adapter: ProviderAdapter = {
    type,
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(req) {
      requests.push(req);
      return (async function* () {
        yield { type: 'text' as const, delta: 'deployed' };
        yield { type: 'finish' as const, reason: 'stop' };
      })();
    },
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
    ...(envForRun === undefined ? {} : { envForRun }),
  });
  const input: ExecuteNodeInput = {
    runId: RUN_ID,
    workflowId: WORKFLOW_ID,
    nodeRunId: '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5',
    node,
    envelopes: [envelope],
    iteration: 1,
    attempt: 1,
    runInputs: {},
    signal: new AbortController().signal,
  };
  const outcome = await executor.execute(input);
  return { outcome, request: requests[0] };
}

describe('D274 secrets reach a CLI agent as its environment, and only their names its prompt', () => {
  it('hands a CLI route the env and names the variables under ### Environment', async () => {
    const { outcome, request } = await run('claude_code', async () => ENV);
    const plain = await run('claude_code');

    expect(outcome.status).toBe('COMPLETED');
    expect(request?.env).toEqual(ENV);
    expect(request?.prompt).toContain(
      '### Environment\nThese environment variables are set for the commands you run: API_URL, DEPLOY_TOKEN. Never print their values.',
    );
    // The block sits in the Context section, before the Input.
    const prompt = request?.prompt ?? '';
    expect(prompt.indexOf('### Environment')).toBeGreaterThan(prompt.indexOf('## Context'));
    expect(prompt.indexOf('### Environment')).toBeLessThan(prompt.indexOf('## Input'));
    // Names only: no value is in the prompt sent or the prompt recorded.
    for (const value of Object.values(ENV)) {
      expect(prompt).not.toContain(value);
      expect(outcome.prompt?.text ?? '').not.toContain(value);
    }
    expect(outcome.prompt?.text).toContain('### Environment');
    expect(outcome.prompt?.version).not.toBe(plain.outcome.prompt?.version);
  });

  it.each<ProviderType>(['anthropic', 'openai', 'google', 'ollama', 'openai_compatible', 'mock'])(
    'gives a %s route neither the values nor the names',
    async (type) => {
      const { outcome, request } = await run(type, async () => ENV);
      const plain = await run(type);
      expect(request).not.toHaveProperty('env');
      expect(request?.prompt).not.toContain('### Environment');
      expect(request?.prompt).not.toContain('DEPLOY_TOKEN');
      expect(request?.prompt).toBe(plain.request?.prompt);
      expect(outcome.prompt?.version).toBe(plain.outcome.prompt?.version);
    },
  );

  it('sends a CLI the prompt it always had when no secret is in scope', async () => {
    const empty = await run('claude_code', async () => ({}));
    const none = await run('claude_code', async () => undefined);
    const plain = await run('claude_code');
    for (const { request, outcome } of [empty, none]) {
      expect(request).not.toHaveProperty('env');
      expect(request?.prompt).toBe(plain.request?.prompt);
      expect(outcome.prompt).toEqual(plain.outcome.prompt);
    }
  });

  it('runs without the secrets when they cannot be read', async () => {
    const { outcome, request } = await run('claude_code', async () => {
      throw new Error('keychain locked');
    });
    expect(outcome.status).toBe('COMPLETED');
    expect(request).not.toHaveProperty('env');
    expect(request?.prompt).not.toContain('### Environment');
  });
});
