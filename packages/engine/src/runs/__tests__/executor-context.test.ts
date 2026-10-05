import {
  AgentConfigSchema,
  MEMORY_OUTPUT_FIELD,
  MEMORY_PROMPT_HEADING,
  ModelConfigSchema,
  RetrievalConfigSchema,
  derivePorts,
  type Envelope,
  type MemoryOp,
  type Model,
  type Node,
  type NodeRunSource,
  type Part,
  type SearchHit,
  type Verdict,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createEventBus } from '../../events/index.js';
import { createLogger } from '../../logging/index.js';
import { KnowledgeBaseMissingError, type SearchService } from '../../knowledge/search.js';
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
  type NodeContextHook,
  type NodeGuardrails,
  type NodeMemoryHook,
} from '../executor.js';

/**
 * The executor's round 5 hooks (round 5 §2.2–§2.4, Task 13): the context hook before the input
 * point, `__memory` taken out before the output point, and the Retrieval node.
 */

const scope = LOCAL_SCOPE;
const NOW = '2026-10-04T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const UPSTREAM = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const KB_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0KBAS';
const KEY_SHAPED = ['sk', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-');

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function agentNode(config: Record<string, unknown> = {}): Node {
  const parsed = AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    instructions: 'Answer the question.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    ...config,
  });
  return {
    id: NODE_ID,
    workflowId: WORKFLOW_ID,
    kind: 'agent',
    name: 'Answerer',
    position: { x: 0, y: 0 },
    ...derivePorts({ id: NODE_ID, kind: 'agent', config: parsed }),
    config: parsed,
  };
}

function modelNode(): Node {
  const config = ModelConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    inputTypes: ['text'],
    outputTypes: ['text'],
  });
  return {
    id: NODE_ID,
    workflowId: WORKFLOW_ID,
    kind: 'model',
    name: 'Rewriter',
    position: { x: 0, y: 0 },
    ...derivePorts({ id: NODE_ID, kind: 'model', config }),
    config,
  };
}

function retrievalNode(config: Record<string, unknown> = { knowledgeBaseId: KB_ID }): Node {
  const parsed = RetrievalConfigSchema.parse(config);
  return {
    id: NODE_ID,
    workflowId: WORKFLOW_ID,
    kind: 'retrieval',
    name: 'Search',
    position: { x: 0, y: 0 },
    ...derivePorts({ id: NODE_ID, kind: 'retrieval', config: parsed }),
    config: parsed,
  };
}

const envelope = (reads: Part[] = [{ type: 'text', text: 'What is ACE?' }]): Envelope => ({
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

const source = (chunkId: string, score: number): NodeRunSource => ({
  chunkId,
  documentId: '01JBXQ8Z9KQ4R7N2VWXYZ0DOC1',
  score,
  source: `handbook.md#${score}`,
});

const say = (text: string): StreamChunk[] => [
  { type: 'text', delta: text },
  { type: 'usage', tokensIn: 2, tokensOut: 3 },
  { type: 'finish', reason: 'stop' },
];

const answerJson = (value: unknown): StreamChunk[] => [
  { type: 'json', value },
  { type: 'usage', tokensIn: 2, tokensOut: 3 },
  { type: 'finish', reason: 'stop' },
];

interface Harness {
  run(
    node: Node,
    extra?: Partial<ExecuteNodeInput>,
    envelopes?: Envelope[],
  ): ReturnType<ReturnType<typeof createNodeExecutor>['execute']>;
  requests: GenerateRequest[];
  events: EngineEvent[];
  logs: string[];
}

async function harness(
  options: { reply?: (req: GenerateRequest) => StreamChunk[]; search?: SearchService } = {},
): Promise<Harness> {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));
  const requests: GenerateRequest[] = [];
  const logs: string[] = [];
  const reply = options.reply ?? (() => say('ok'));

  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(req) {
      requests.push(req);
      const chunks = reply(req);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };

  const executor = createNodeExecutor({
    bus,
    logger: createLogger({ level: 'warn', destination: { write: (line) => logs.push(line) } }),
    now: () => NOW,
    adapterFor: async () => adapter,
    modelsFor: async () => [model],
    router,
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
    ...(options.search === undefined ? {} : { search: options.search }),
  });

  return {
    requests,
    events,
    logs,
    run: (node, extra = {}, envelopes = [envelope()]) =>
      executor.execute({
        runId: RUN_ID,
        workflowId: WORKFLOW_ID,
        nodeRunId: NODE_RUN_ID,
        node,
        envelopes,
        iteration: 1,
        attempt: 1,
        runInputs: {},
        signal: new AbortController().signal,
        ...extra,
      }),
  };
}

/** A context hook that answers `step`, remembering what it was handed and when. */
function contextHook(
  step: Awaited<ReturnType<NodeContextHook['build']>>,
  order: string[] = [],
): NodeContextHook & { seen: (readonly Envelope[])[] } {
  const seen: (readonly Envelope[])[] = [];
  return {
    seen,
    async build(envelopes) {
      order.push('context');
      seen.push(envelopes);
      return step;
    },
  };
}

function memoryHook(enabled = true): NodeMemoryHook & { applied: MemoryOp[][] } {
  const applied: MemoryOp[][] = [];
  return {
    enabled,
    applied,
    async apply(ops) {
      applied.push(ops);
    },
  };
}

const withRetrieved = (base: Envelope): Envelope => ({
  ...base,
  context: {
    ...base.context,
    retrieved: [
      {
        chunkId: '01JBXQ8Z9KQ4R7N2VWXYZ0CHK1',
        text: 'ACE is an agent canvas.',
        score: 0.9,
        source: 'handbook.md#0.9',
      },
    ],
  },
});

/* -------------------------------------------------------------------------- */
/* The context hook                                                            */
/* -------------------------------------------------------------------------- */

describe('FR-RAG-007 the context hook builds what an agent reads, before the input point', () => {
  it('runs before beforePrompt, its envelopes reach the prompt, and its sources go on the outcome', async () => {
    const h = await harness();
    const order: string[] = [];
    const context = contextHook(
      {
        kind: 'continue',
        envelopes: [withRetrieved(envelope())],
        sources: [source('01JBXQ8Z9KQ4R7N2VWXYZ0CHK1', 0.9)],
        droppedSources: [source('01JBXQ8Z9KQ4R7N2VWXYZ0CHK2', 0.1)],
        usedMemoryIds: [],
      },
      order,
    );
    const seenByInputPoint: (readonly Envelope[])[] = [];
    const guardrails: NodeGuardrails = {
      async beforePrompt(envelopes) {
        order.push('input');
        seenByInputPoint.push(envelopes);
        return { kind: 'continue', envelopes: [...envelopes] };
      },
    };

    const outcome = await h.run(agentNode(), { context, guardrails });

    expect(order).toEqual(['context', 'input']);
    expect(seenByInputPoint[0]?.[0]?.context.retrieved).toHaveLength(1);
    expect(h.requests[0]?.prompt).toContain('ACE is an agent canvas.');
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.sources).toEqual([source('01JBXQ8Z9KQ4R7N2VWXYZ0CHK1', 0.9)]);
    expect(outcome.droppedSources).toEqual([source('01JBXQ8Z9KQ4R7N2VWXYZ0CHK2', 0.1)]);
  });

  it('runs for a Model node too', async () => {
    const h = await harness();
    const context = contextHook({
      kind: 'continue',
      envelopes: [envelope([{ type: 'text', text: 'guarded read' }])],
      sources: [],
      droppedSources: [],
      usedMemoryIds: [],
    });

    const outcome = await h.run(modelNode(), { context });

    expect(context.seen).toHaveLength(1);
    expect(h.requests[0]?.prompt).toContain('guarded read');
    expect(outcome.status).toBe('COMPLETED');
    // Nothing used, so nothing recorded: the outcome is the round 4 shape.
    expect(outcome).not.toHaveProperty('sources');
    expect(outcome).not.toHaveProperty('droppedSources');
  });

  it('FR-GRD-004 a failed step fails the node with its reason and error, and calls no model', async () => {
    const h = await harness();
    const verdict = { id: 'v1' } as unknown as Verdict;
    const context = contextHook({
      kind: 'failed',
      failureReason: 'GUARDRAIL_VIOLATION',
      error: {
        kind: 'guardrail',
        code: 'guardrail_prompt_injection',
        message: 'Hidden instructions found (in a retrieved chunk).',
        retryable: false,
      },
      verdicts: [verdict],
    });

    const outcome = await h.run(agentNode(), { context });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('GUARDRAIL_VIOLATION');
    expect(outcome.error?.code).toBe('guardrail_prompt_injection');
    expect(outcome.verdicts).toEqual([verdict]);
    expect(h.requests).toHaveLength(0);
  });

  it('a BLOCKED step (a base deleted mid-run) leaves the node BLOCKED', async () => {
    const h = await harness();
    const context = contextHook({
      kind: 'failed',
      failureReason: 'BLOCKED',
      error: new KnowledgeBaseMissingError(KB_ID).nodeError,
    });

    const outcome = await h.run(agentNode({ knowledgeBaseIds: [KB_ID] }), { context });

    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.error?.code).toBe('missing_knowledge_base');
  });
});

/* -------------------------------------------------------------------------- */
/* Memory                                                                      */
/* -------------------------------------------------------------------------- */

const STRICT_ANSWER = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

const memoryAgent = (): Node =>
  agentNode({
    outputTypes: ['json'],
    outputContract: { jsonSchema: STRICT_ANSWER },
    memory: { enabled: true },
  });

describe('FR-MEM-002 an agent with memory enabled', () => {
  it('gets the memory-operations block in its prompt', async () => {
    const h = await harness({ reply: () => answerJson({ answer: 'Hi.' }) });

    await h.run(memoryAgent(), { memory: memoryHook() });

    expect(h.requests[0]?.prompt).toContain(MEMORY_PROMPT_HEADING);
  });

  it('m2: a text-only agent with memory on gets no memory block, and its text answer is left alone', async () => {
    const text = `Hi. {"${MEMORY_OUTPUT_FIELD}": [{"op": "save", "key": "k", "value": "v"}]}`;
    const h = await harness({ reply: () => say(text) });
    const memory = memoryHook();

    const outcome = await h.run(agentNode({ memory: { enabled: true } }), { memory });

    // `__memory` is a field of the JSON output (§2.2): nothing reads it from text, so no agent is
    // told to write it there.
    expect(h.requests[0]?.prompt).not.toContain(MEMORY_PROMPT_HEADING);
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'text', text }]);
    expect(memory.applied).toEqual([]);
    expect(outcome).not.toHaveProperty('memoryOps');
  });

  it('m2: the schema sent to the provider allows an optional __memory list; the contract is the user one', async () => {
    const h = await harness({ reply: () => answerJson({ answer: 'Hi.' }) });

    await h.run(memoryAgent(), { memory: memoryHook() });

    const sent = h.requests[0]?.jsonSchema as {
      properties: Record<string, { type?: string; items?: unknown }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(sent.properties[MEMORY_OUTPUT_FIELD]).toMatchObject({ type: 'array' });
    expect(sent.properties[MEMORY_OUTPUT_FIELD]?.items).toBeDefined();
    expect(sent.properties['answer']).toEqual({ type: 'string' });
    expect(sent.required).toEqual(['answer']);
    expect(sent.additionalProperties).toBe(false);
    // The agent's own schema is untouched: it is what the contract is validated against.
    expect(STRICT_ANSWER.properties).not.toHaveProperty(MEMORY_OUTPUT_FIELD);
    // …and the prompt's output contract states the agent's schema, not the widened one.
    expect(h.requests[0]?.prompt).not.toContain(`"${MEMORY_OUTPUT_FIELD}":{"items"`);
  });

  it('m2: the widened schema accepts a schema-enforced __memory, the contract still rejects anything else', async () => {
    const h = await harness({
      reply: () =>
        answerJson({
          answer: 'Hi.',
          extra: 'not in the schema',
          [MEMORY_OUTPUT_FIELD]: [{ op: 'save', key: 'tone', value: 'brief' }],
        }),
    });
    const memory = memoryHook();

    const outcome = await h.run(memoryAgent(), { memory });

    expect(outcome.failureReason).toBe('CONTRACT_VIOLATION');
    expect(memory.applied).toEqual([]);
  });

  it('m2: with memory off the provider gets the agent schema exactly', async () => {
    const h = await harness({ reply: () => answerJson({ answer: 'Hi.' }) });

    await h.run(
      agentNode({ outputTypes: ['json'], outputContract: { jsonSchema: STRICT_ANSWER } }),
      { memory: memoryHook(false) },
    );

    expect(h.requests[0]?.jsonSchema).toEqual(STRICT_ANSWER);
  });

  it('has __memory stripped before the output point and the contract, then applied and recorded', async () => {
    const h = await harness({
      reply: () =>
        answerJson({
          answer: 'Hello, Ada.',
          [MEMORY_OUTPUT_FIELD]: [{ op: 'save', key: 'user_name', value: 'Ada' }],
        }),
    });
    const memory = memoryHook();
    const atOutputPoint: Part[][] = [];

    const outcome = await h.run(memoryAgent(), {
      memory,
      guardrails: {
        async afterOutput(parts) {
          atOutputPoint.push(parts);
          return { kind: 'continue', parts };
        },
      },
    });

    expect(atOutputPoint[0]).toEqual([{ type: 'json', value: { answer: 'Hello, Ada.' } }]);
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'json', value: { answer: 'Hello, Ada.' } }]);
    expect(memory.applied).toEqual([[{ op: 'save', key: 'user_name', value: 'Ada' }]]);
    expect(outcome.memoryOps).toEqual([{ op: 'save', key: 'user_name', value: 'Ada' }]);
    expect(JSON.stringify(h.events)).not.toContain(MEMORY_OUTPUT_FIELD);
  });

  it('strips __memory from a JSON answer that arrived as text, so the strict contract still passes', async () => {
    const h = await harness({
      reply: () =>
        say(
          JSON.stringify({
            answer: 'Done.',
            [MEMORY_OUTPUT_FIELD]: [{ op: 'delete', key: 'user_name' }],
          }),
        ),
    });
    const memory = memoryHook();

    const outcome = await h.run(memoryAgent(), { memory });

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'json', value: { answer: 'Done.' } }]);
    expect(outcome.memoryOps).toEqual([{ op: 'delete', key: 'user_name' }]);
  });

  it('logs invalid ops without their values and applies the valid ones; the answer still validates', async () => {
    const h = await harness({
      reply: () =>
        answerJson({
          answer: 'Ok.',
          [MEMORY_OUTPUT_FIELD]: [
            { op: 'save', key: '', value: 'secret-ish value' },
            { op: 'save', key: 'tone', value: 'brief' },
          ],
        }),
    });
    const memory = memoryHook();

    const outcome = await h.run(memoryAgent(), { memory });

    expect(outcome.status).toBe('COMPLETED');
    expect(memory.applied).toEqual([[{ op: 'save', key: 'tone', value: 'brief' }]]);
    expect(outcome.memoryOps).toEqual([{ op: 'save', key: 'tone', value: 'brief' }]);
    const warning = h.logs.find((line) => line.includes('op 0'));
    expect(warning).toBeDefined();
    expect(warning).not.toContain('secret-ish value');
  });

  it('records a key-shaped value masked, as it is stored', async () => {
    const h = await harness({
      reply: () =>
        answerJson({
          answer: 'Ok.',
          [MEMORY_OUTPUT_FIELD]: [{ op: 'save', key: 'token', value: `use ${KEY_SHAPED}` }],
        }),
    });
    const memory = memoryHook();

    const outcome = await h.run(memoryAgent(), { memory });

    expect(JSON.stringify(outcome.memoryOps)).not.toContain(KEY_SHAPED);
    expect(outcome.memoryOps?.[0]).toMatchObject({ op: 'save', key: 'token' });
  });

  it('applies nothing when the answer fails its contract', async () => {
    const h = await harness({
      reply: () =>
        answerJson({
          wrong: true,
          [MEMORY_OUTPUT_FIELD]: [{ op: 'save', key: 'user_name', value: 'Ada' }],
        }),
    });
    const memory = memoryHook();

    const outcome = await h.run(memoryAgent(), { memory });

    expect(outcome.failureReason).toBe('CONTRACT_VIOLATION');
    expect(memory.applied).toEqual([]);
    expect(outcome).not.toHaveProperty('memoryOps');
  });

  it('m1: a store that refuses the ops after a paid call fails the node, keeping what the call spent', async () => {
    const h = await harness({
      reply: () =>
        answerJson({
          answer: 'Hello, Ada.',
          [MEMORY_OUTPUT_FIELD]: [{ op: 'save', key: 'user_name', value: 'Ada' }],
        }),
    });
    const memory: NodeMemoryHook = {
      enabled: true,
      async apply() {
        throw new Error('SQLITE_FULL: database or disk is full');
      },
    };

    const outcome = await h.run(memoryAgent(), { memory });

    expect(outcome.status).toBe('FAILED');
    expect(outcome.failureReason).toBe('RUN_FAILED');
    expect(outcome.error).toMatchObject({
      kind: 'workflow',
      code: 'memory_not_saved',
      retryable: false,
    });
    expect(outcome.error?.message).toMatch(/memory/i);
    // The call was made and paid for: its usage, model and prompt stay on the node run.
    expect(outcome.usage).toMatchObject({ tokensIn: 2, tokensOut: 3 });
    expect(outcome.modelUsed?.modelId).toBe('scripted');
    expect(outcome.prompt?.text).toContain(MEMORY_PROMPT_HEADING);
    // Nothing was saved, so nothing is recorded as applied, and nothing flows on.
    expect(outcome).not.toHaveProperty('memoryOps');
    expect(outcome.output).toEqual([]);
    expect(h.events.map((event) => event.type)).toContain('node.error');
    expect(h.events.map((event) => event.type)).not.toContain('node.output');
    expect(h.logs.some((line) => line.includes('memory ops could not be saved'))).toBe(true);
    expect(h.logs.join('\n')).not.toContain('Ada"');
  });

  it('with memory off: no block in the prompt, and __memory is left in the output', async () => {
    const h = await harness({
      reply: () =>
        answerJson({ answer: 'Hi.', [MEMORY_OUTPUT_FIELD]: [{ op: 'delete', key: 'k' }] }),
    });
    const memory = memoryHook(false);

    const outcome = await h.run(agentNode({ outputTypes: ['json'] }), { memory });

    expect(h.requests[0]?.prompt).not.toContain(MEMORY_PROMPT_HEADING);
    expect(outcome.output).toEqual([
      {
        type: 'json',
        value: { answer: 'Hi.', [MEMORY_OUTPUT_FIELD]: [{ op: 'delete', key: 'k' }] },
      },
    ]);
    expect(memory.applied).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The Retrieval node                                                          */
/* -------------------------------------------------------------------------- */

function searchFor(hits: SearchHit[] | Error): SearchService & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(_kbId, req) {
      queries.push(req.query);
      if (hits instanceof Error) throw hits;
      return { hits, tookMs: 1 };
    },
  };
}

const searchHit: SearchHit = {
  chunkId: '01JBXQ8Z9KQ4R7N2VWXYZ0CHK1',
  documentId: '01JBXQ8Z9KQ4R7N2VWXYZ0DOC1',
  text: 'ACE is an agent canvas.',
  score: 0.9,
  source: 'handbook.md#intro',
  via: 'both',
};

describe('FR-RAG-006 the Retrieval node', () => {
  it('searches its base with its reads and records every hit as a source', async () => {
    const search = searchFor([searchHit]);
    const h = await harness({ search });

    const outcome = await h.run(retrievalNode());

    expect(search.queries).toEqual(['What is ACE?']);
    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'json', value: { hits: [searchHit] } }]);
    expect(outcome.sources).toEqual([
      {
        chunkId: searchHit.chunkId,
        documentId: searchHit.documentId,
        score: 0.9,
        source: 'handbook.md#intro',
      },
    ]);
  });

  it('is BLOCKED missing_knowledge_base when its base was deleted mid-run', async () => {
    const h = await harness({ search: searchFor(new KnowledgeBaseMissingError(KB_ID)) });

    const outcome = await h.run(retrievalNode());

    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.failureReason).toBe('BLOCKED');
    expect(outcome.error?.code).toBe('missing_knowledge_base');
  });

  it('is BLOCKED when no base is chosen', async () => {
    const h = await harness({ search: searchFor([]) });

    const outcome = await h.run(retrievalNode({}));

    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.error?.code).toBe('missing_knowledge_base');
  });

  it('is BLOCKED when the engine has no search service', async () => {
    const h = await harness();

    const outcome = await h.run(retrievalNode());

    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.error?.kind).toBe('invalid_config');
    expect(outcome.error?.code).toBe('knowledge_unavailable');
  });
});
