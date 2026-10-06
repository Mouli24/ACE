import {
  AgentConfigSchema,
  type Envelope,
  type Model,
  type Node,
  type ToolCall,
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
  type StreamChunk,
} from '../../ports/index.js';
import { activityToolName, createNodeExecutor, type ExecuteNodeInput } from '../executor.js';

const NOW = '2026-10-06T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const UPSTREAM = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';

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
    instructions: 'Fix the failing test.',
    inputTypes: ['text'],
    outputTypes: ['text'],
  }),
};

const model: Model = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'sonnet',
  displayName: 'Claude Sonnet',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  pricing: { inputPer1k: 0.003, outputPer1k: 0.015, priceTableVersion: 'v1' },
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

const route = { ok: true as const, route: { providerId: PROVIDER_ID, modelId: 'sonnet', viaFallback: false } };
const router: ModelRouter = { resolve: () => route, resolveForBench: () => route };

async function run(chunks: StreamChunk[], options: { projectFolder?: string } = {}) {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope: LOCAL_SCOPE, pubsub, now: () => NOW });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  const requests: GenerateRequest[] = [];
  const logged: ToolCall[] = [];
  const adapter: ProviderAdapter = {
    type: 'claude_code',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(req) {
      requests.push(req);
      return (async function* () {
        yield* chunks;
      })();
    },
  };
  let seq = 0;
  const executor = createNodeExecutor({
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => NOW,
    nextId: () => `01JBXQ8Z9KQ4R7N2VWXYZ0T${String(seq++).padStart(2, '0')}`,
    adapterFor: async () => adapter,
    modelsFor: async () => [model],
    router,
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
    recordToolCall: async (_runId, call) => {
      logged.push(call);
    },
    ...(options.projectFolder === undefined
      ? {}
      : { projectFolderFor: async () => options.projectFolder }),
  });

  const input: ExecuteNodeInput = {
    runId: RUN_ID,
    workflowId: WORKFLOW_ID,
    nodeRunId: NODE_RUN_ID,
    node,
    envelopes: [envelope],
    iteration: 1,
    attempt: 1,
    runInputs: {},
    signal: new AbortController().signal,
  };
  const outcome = await executor.execute(input);
  return { outcome, requests, logged, events };
}

const done: StreamChunk[] = [{ type: 'text', delta: 'ok' }, { type: 'finish', reason: 'stop' }];

describe('X1 §4.3 a provider’s own actions (agent route, D261)', () => {
  it('records each action as a ToolCall and a tool.call event, with no guardrail verdicts', async () => {
    const { outcome, logged, events } = await run([
      { type: 'activity', tool: 'Bash', args: { command: 'node --test' }, status: 'ok', summary: '3 passed', durationMs: 900 },
      { type: 'activity', tool: 'Edit', args: { file_path: 'src/math.js' }, status: 'error', summary: 'old_string not found', durationMs: 12 },
      { type: 'text', delta: 'Added multiply; the tests pass.' },
      { type: 'usage', tokensIn: 100, tokensOut: 20 },
      { type: 'finish', reason: 'stop' },
    ]);

    expect(outcome.status).toBe('COMPLETED');
    expect(
      logged.map((call) => [call.toolName, call.status, call.resultSummary, call.durationMs, call.verdicts]),
    ).toEqual([
      ['cli_bash', 'ok', '3 passed', 900, []],
      ['cli_edit', 'error', 'old_string not found', 12, []],
    ]);
    expect(logged[0]?.args).toEqual({ command: 'node --test' });
    expect(events.filter((event) => event.type === 'tool.call')).toHaveLength(2);
  });

  it('D263 uses the cost the provider reported instead of the price table', async () => {
    const { outcome } = await run([
      { type: 'text', delta: 'ok' },
      { type: 'usage', tokensIn: 1000, tokensOut: 1000, costUsd: 0.42 },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(outcome.usage).toMatchObject({ tokensIn: 1000, tokensOut: 1000, costUsd: 0.42 });
  });

  it('prices from the table when the provider reports no cost', async () => {
    const { outcome } = await run([
      { type: 'text', delta: 'ok' },
      { type: 'usage', tokensIn: 1000, tokensOut: 1000 },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(outcome.usage.costUsd).toBeCloseTo(0.018, 6);
  });

  it('hands the project folder to the provider as workingDir', async () => {
    const { requests } = await run(done, { projectFolder: 'D:\\ACE offcl\\demo' });
    expect(requests[0]?.workingDir).toBe('D:\\ACE offcl\\demo');
  });

  it('sends no workingDir when the run has no project folder', async () => {
    const { requests } = await run(done);
    expect(requests[0]).not.toHaveProperty('workingDir');
  });
});

describe('activityToolName', () => {
  it.each([
    ['Bash', 'cli_bash'],
    ['WebFetch', 'cli_web_fetch'],
    ['mcp__github__create_issue', 'cli_mcp_github_create_issue'],
    ['file_change', 'cli_file_change'],
    ['command', 'cli_command'],
    ['!!', 'cli_action'],
  ])('%s → %s', (tool, name) => {
    expect(activityToolName(tool)).toBe(name);
    expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
