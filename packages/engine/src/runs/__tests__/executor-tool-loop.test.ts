import {
  AgentConfigSchema,
  type Envelope,
  type Model,
  type Node,
  type Part,
  type ToolCall,
  type ToolDefinition,
} from '@ace/contracts';
import { describe, expect, it, vi } from 'vitest';

import { createEventBus } from '../../events/index.js';
import { createLogger } from '../../logging/index.js';
import type {
  EngineEvent,
  GenerateRequest,
  ModelRouter,
  ProviderAdapter,
  StreamChunk,
} from '../../ports/index.js';
import { LOCAL_SCOPE } from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import {
  createNodeExecutor,
  type ExecuteNodeInput,
  type NodeExecutionOutcome,
  type NodeExecutor,
  type NodeGuardrails,
} from '../executor.js';
import {
  UNTRUSTED_TOOL_RESULT_LABEL,
  type ArtifactMaterialiser,
  type ExecutableTool,
  type ToolGuardStep,
  type ToolPointInput,
  type ToolProvider,
} from '../tool-loop.js';

const scope = LOCAL_SCOPE;
const NOW = '2026-09-30T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const UPSTREAM = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const INPUT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0INP1';
const ART_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ART1';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const agentNode = (config: Record<string, unknown> = {}): Node => ({
  id: NODE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'agent',
  name: 'Worker',
  position: { x: 0, y: 0 },
  inputs: [{ id: `${NODE_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${NODE_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    instructions: 'Use tools as needed.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    ...config,
  }),
});

const inputNode = (artifactIds: string[], text?: string): Node => ({
  id: INPUT_ID,
  workflowId: WORKFLOW_ID,
  kind: 'input',
  name: 'Input',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [{ id: `${INPUT_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: { artifactIds, outputTypes: ['text'], ...(text === undefined ? {} : { text }) },
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
  inputTypes: ['text', 'image', 'audio', 'video', 'file'],
  outputTypes: ['text', 'json', 'code', 'image', 'audio', 'video', 'file'],
  contextWindow: 200_000,
  supportsTools: true,
  supportsJson: true,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  pricing: { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
  ...overrides,
});

const echoDefinition: ToolDefinition = {
  name: 'echo',
  description: 'echoes',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: [], destructive: false },
  timeoutMs: 5000,
  source: 'builtin',
};

const deleteDefinition: ToolDefinition = {
  ...echoDefinition,
  name: 'sandbox_delete',
  permissions: { network: false, fsPaths: ['<sandbox>'], destructive: true },
};

/* An adapter driven by a per-turn script: each call sees what the last tool returned. */
type Turn = StreamChunk[];
function scriptedAdapter(turns: (req: GenerateRequest) => Turn) {
  const requests: GenerateRequest[] = [];
  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(req) {
      requests.push(req);
      const chunks = turns(req);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
  return { adapter, requests };
}

function stubRouter(models: Model[]): ModelRouter {
  const resolve: ModelRouter['resolve'] = (node) => {
    const row = models.find((m) => m.modelId === node.modelId && m.providerId === node.providerId);
    return row === undefined
      ? { ok: false, code: 'unavailable_model', reason: 'no model' }
      : {
          ok: true,
          route: { providerId: row.providerId, modelId: row.modelId, viaFallback: false },
        };
  };
  return { resolve, resolveForBench: resolve };
}

/* A recording tool. `run` returns `result` or throws `error`. */
function fakeTool(
  definition: ToolDefinition,
  behaviour: { result?: unknown; error?: Error } = {},
): ExecutableTool & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    definition,
    calls,
    async run(args) {
      calls.push(args);
      if (behaviour.error !== undefined) throw behaviour.error;
      return behaviour.result ?? { text: `echoed ${JSON.stringify(args)}` };
    },
  };
}

function toolProvider(tools: ExecutableTool[]): ToolProvider {
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  return { get: (name) => byName.get(name) };
}

interface Harness {
  executor: NodeExecutor;
  events: EngineEvent[];
  requests: GenerateRequest[];
  logged: { runId: string; call: ToolCall }[];
}

async function buildHarness(options: {
  turns: (req: GenerateRequest) => Turn;
  models?: Model[];
  tools?: ToolProvider;
  artifacts?: ArtifactMaterialiser;
  beforeTool?: (input: ToolPointInput) => Promise<ToolGuardStep>;
  maxToolCalls?: number;
}): Promise<Harness & { guardrails?: NodeGuardrails }> {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  const models = options.models ?? [model()];
  const { adapter, requests } = scriptedAdapter(options.turns);
  const logged: { runId: string; call: ToolCall }[] = [];
  let idSeq = 0;

  const executor = createNodeExecutor({
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    now: () => NOW,
    nextId: () => `01JBXQ8Z9KQ4R7N2VWXYZ0T${String(idSeq++).padStart(2, '0')}`,
    adapterFor: async () => adapter,
    modelsFor: async () => models,
    router: stubRouter(models),
    runGated: async (_p, fn) => fn(),
    tokenBatchMs: 0,
    sandboxDirFor: (runId) => `/tmp/.ace/sandbox/${runId}/`,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    recordToolCall: async (runId, call) => {
      logged.push({ runId, call });
    },
  });

  const guardrails: NodeGuardrails | undefined =
    options.beforeTool === undefined && options.maxToolCalls === undefined
      ? undefined
      : {
          ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
          ...(options.beforeTool === undefined ? {} : { beforeTool: options.beforeTool }),
        };

  return { executor, events, requests, logged, ...(guardrails === undefined ? {} : { guardrails }) };
}

function runInput(
  harness: Harness & { guardrails?: NodeGuardrails },
  node: Node,
): Promise<NodeExecutionOutcome> {
  const input: ExecuteNodeInput = {
    runId: RUN_ID,
    workflowId: WORKFLOW_ID,
    nodeRunId: NODE_RUN_ID,
    node,
    envelopes: node.kind === 'input' ? [] : [envelope()],
    iteration: 1,
    attempt: 1,
    runInputs: {},
    signal: new AbortController().signal,
    ...(harness.guardrails === undefined ? {} : { guardrails: harness.guardrails }),
  };
  return harness.executor.execute(input);
}

/* Turn scripts. */
const finish = (reason: 'stop' | 'tool_calls' = 'stop'): StreamChunk => ({ type: 'finish', reason });
const usage = (tokensIn: number, tokensOut: number): StreamChunk => ({ type: 'usage', tokensIn, tokensOut });
const say = (text: string): StreamChunk[] => [{ type: 'text', delta: text }, usage(2, 3), finish()];
const requestEcho = (): StreamChunk[] => [
  { type: 'tool_call', callId: '01JBXQ8Z9KQ4R7N2VWXYZ0CAL1', name: 'echo', args: { text: 'hi' } },
  usage(2, 0),
  finish('tool_calls'),
];

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('TC-TOOL-001 an agent runs a tool and feeds its result back', () => {
  it('executes the requested tool, then answers, and offers the enabled tool to the model', async () => {
    const echo = fakeTool(echoDefinition, { result: { text: 'echoed hi' } });
    const harness = await buildHarness({
      turns: (req) => (req.toolResults?.length ? say('echo said: echoed hi') : requestEcho()),
      tools: toolProvider([echo]),
      beforeTool: async () => ({ kind: 'allow' }),
      maxToolCalls: 10,
    });

    const outcome = await runInput(harness, agentNode({ tools: { enabled: ['echo'], maxToolCalls: 10, allowedDomains: [] } }));

    expect(outcome.status).toBe('COMPLETED');
    expect(echo.calls).toEqual([{ text: 'hi' }]);
    // The first turn offered the tool; the second fed the result back.
    expect(harness.requests[0]?.tools?.map((t) => t.name)).toEqual(['echo']);
    expect(harness.requests[1]?.toolResults).toEqual([
      { callId: '01JBXQ8Z9KQ4R7N2VWXYZ0CAL1', name: 'echo', result: { text: 'echoed hi' } },
    ]);
  });

  it('FR-TOOL-009 logs the ToolCall and emits a tool.call event', async () => {
    const echo = fakeTool(echoDefinition, { result: { text: 'echoed hi' } });
    const harness = await buildHarness({
      turns: (req) => (req.toolResults?.length ? say('done') : requestEcho()),
      tools: toolProvider([echo]),
      beforeTool: async () => ({ kind: 'allow' }),
      maxToolCalls: 10,
    });

    await runInput(harness, agentNode({ tools: { enabled: ['echo'], maxToolCalls: 10, allowedDomains: [] } }));

    expect(harness.logged).toHaveLength(1);
    expect(harness.logged[0]?.call).toMatchObject({ toolName: 'echo', status: 'ok' });
    const toolEvents = harness.events.filter((e) => e.type === 'tool.call');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.payload).toMatchObject({
      runId: RUN_ID,
      nodeRunId: NODE_RUN_ID,
      toolCall: { toolName: 'echo', status: 'ok' },
    });
  });

  it('TC-TOOL-011 / TC-PRM-002 the recorded prompt carries the tool result inside the untrusted block', async () => {
    const echo = fakeTool(echoDefinition, { result: { text: 'echoed hi' } });
    const harness = await buildHarness({
      turns: (req) => (req.toolResults?.length ? say('done') : requestEcho()),
      tools: toolProvider([echo]),
      beforeTool: async () => ({ kind: 'allow' }),
      maxToolCalls: 10,
    });

    const outcome = await runInput(harness, agentNode({ tools: { enabled: ['echo'], maxToolCalls: 10, allowedDomains: [] } }));

    expect(outcome.prompt?.text).toContain(UNTRUSTED_TOOL_RESULT_LABEL);
    expect(outcome.prompt?.text).toContain('echo');
  });
});

describe('TC-TOOL-002 a tool the tool point blocks fails the node GUARDRAIL_VIOLATION', () => {
  it('logs a blocked ToolCall, does not execute the tool, and fails GUARDRAIL_VIOLATION', async () => {
    const echo = fakeTool(echoDefinition);
    const harness = await buildHarness({
      turns: () => requestEcho(),
      tools: toolProvider([echo]),
      beforeTool: async () => ({ kind: 'block', reason: 'Tool echo is not enabled for this agent.' }),
      maxToolCalls: 10,
    });

    const outcome = await runInput(harness, agentNode({ tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] } }));

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('GUARDRAIL_VIOLATION');
    expect(echo.calls).toHaveLength(0);
    expect(harness.logged[0]?.call.status).toBe('blocked');
  });
});

describe('TC-GRD-008 a rejected destructive approval fails the node GUARDRAIL_VIOLATION', () => {
  it('logs a rejected ToolCall and never runs the tool', async () => {
    const del = fakeTool(deleteDefinition);
    const harness = await buildHarness({
      turns: () => [
        { type: 'tool_call', callId: '01JBXQ8Z9KQ4R7N2VWXYZ0CAL2', name: 'sandbox_delete', args: { path: 'notes.txt' } },
        usage(2, 0),
        finish('tool_calls'),
      ],
      tools: toolProvider([del]),
      beforeTool: async () => ({ kind: 'reject', reason: 'A reviewer rejected this destructive call.' }),
      maxToolCalls: 10,
    });

    const outcome = await runInput(harness, agentNode({ tools: { enabled: ['sandbox_delete'], maxToolCalls: 10, allowedDomains: [] } }));

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('GUARDRAIL_VIOLATION');
    expect(del.calls).toHaveLength(0);
    expect(harness.logged[0]?.call.status).toBe('rejected');
  });
});

describe('TC-GRD-014 the tool-call limit stops the loop', () => {
  it('runs exactly `limit` tools then, still asked, fails RUN_FAILED kind agent', async () => {
    const echo = fakeTool(echoDefinition, { result: { text: 'again' } });
    const harness = await buildHarness({
      // Always asks for a tool, even when none are offered — like mock-tool-loop.
      turns: () => requestEcho(),
      tools: toolProvider([echo]),
      beforeTool: async () => ({ kind: 'allow' }),
      maxToolCalls: 3,
    });

    const outcome = await runInput(
      harness,
      agentNode({ tools: { enabled: ['echo'], maxToolCalls: 5, allowedDomains: [] } }),
    );

    // min(agent 5, policy 3) = 3 executed tool calls, then one no-tool turn still wants a tool.
    expect(echo.calls).toHaveLength(3);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('RUN_FAILED');
    expect(outcome.error?.kind).toBe('agent');
    // The final turn was asked without tools.
    expect(harness.requests[harness.requests.length - 1]?.tools).toBeUndefined();
  });
});

describe('an unregistered tool is blocked (§2.4 tool_not_registered at runtime)', () => {
  it('blocks a tool the registry does not know and fails GUARDRAIL_VIOLATION', async () => {
    const harness = await buildHarness({
      turns: () => requestEcho(),
      tools: toolProvider([]),
      beforeTool: async () => ({ kind: 'allow' }),
      maxToolCalls: 10,
    });

    const outcome = await runInput(harness, agentNode({ tools: { enabled: ['echo'], maxToolCalls: 10, allowedDomains: [] } }));

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('GUARDRAIL_VIOLATION');
    expect(harness.logged[0]?.call.status).toBe('blocked');
  });
});

describe('TC-TOOL-004 a tool error and a timeout are logged, and the model may still answer', () => {
  it('logs status error and hands the failure back as an untrusted result', async () => {
    const echo = fakeTool(echoDefinition, { error: new Error('boom') });
    const harness = await buildHarness({
      turns: (req) => (req.toolResults?.length ? say('recovered') : requestEcho()),
      tools: toolProvider([echo]),
      beforeTool: async () => ({ kind: 'allow' }),
      maxToolCalls: 10,
    });

    const outcome = await runInput(harness, agentNode({ tools: { enabled: ['echo'], maxToolCalls: 10, allowedDomains: [] } }));

    expect(outcome.status).toBe('COMPLETED');
    expect(harness.logged[0]?.call.status).toBe('error');
    expect(harness.requests[1]?.toolResults?.[0]?.result).toMatchObject({ status: 'error' });
  });

  it('logs status timeout when the tool times out', async () => {
    const timeout = Object.assign(new Error('the tool timed out'), { name: 'TimeoutError' });
    const echo = fakeTool(echoDefinition, { error: timeout });
    const harness = await buildHarness({
      turns: (req) => (req.toolResults?.length ? say('ok') : requestEcho()),
      tools: toolProvider([echo]),
      beforeTool: async () => ({ kind: 'allow' }),
      maxToolCalls: 10,
    });

    await runInput(harness, agentNode({ tools: { enabled: ['echo'], maxToolCalls: 10, allowedDomains: [] } }));

    expect(harness.logged[0]?.call.status).toBe('timeout');
  });
});

describe('FR-MM-003 a model that emits media part chunks has them stored as artifacts', () => {
  it('materialises produced media parts and returns them as the output (mock-media)', async () => {
    const placeholder: Part = {
      type: 'image',
      artifactId: '01JBXQ8Z9KQ4R7N2VWXYZ0PLAC',
      mime: 'image/png',
      name: 'x.png',
      size: 10,
    };
    const stored: Part = { ...placeholder, artifactId: ART_ID };
    const store = vi.fn(async (parts: readonly Part[]) =>
      parts.map((part) => (part.type === 'image' ? stored : part)),
    );
    const artifacts: ArtifactMaterialiser = { inputParts: async () => [], store };

    const harness = await buildHarness({
      turns: () => [
        { type: 'part', part: { type: 'text', text: 'a caption' } },
        { type: 'part', part: placeholder },
        usage(1, 1),
        finish(),
      ],
      artifacts,
    });

    const outcome = await runInput(harness, agentNode({ outputTypes: ['text', 'image'] }));

    expect(store).toHaveBeenCalledOnce();
    expect(outcome.status).toBe('COMPLETED');
    // The placeholder id the provider emitted is replaced by the stored artifact's id (FR-MM-003).
    expect(outcome.output).toEqual([{ type: 'text', text: 'a caption' }, stored]);
    // FR-MM-004: the stored parts are references — no inline bytes.
    expect(JSON.stringify(outcome.output)).not.toContain('base64');
  });
});

describe('FR-MM-003 an Input node turns its artifactIds into media part references', () => {
  it('resolves attached artifacts to reference parts alongside the text', async () => {
    const mediaPart: Part = { type: 'image', artifactId: ART_ID, mime: 'image/png', name: 'x.png', size: 10 };
    const artifacts: ArtifactMaterialiser = {
      inputParts: async () => [mediaPart],
      store: async (parts) => [...parts],
    };
    const harness = await buildHarness({ turns: () => say('unused'), artifacts });

    const outcome = await runInput(harness, inputNode([ART_ID], 'a caption'));

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'text', text: 'a caption' }, mediaPart]);
    // FR-MM-004: the stored part is a reference, no bytes.
    expect(JSON.stringify(outcome.output)).not.toContain('base64');
  });
});
