import {
  AgentConfigSchema,
  CONTEXT_BUDGET_SHARES,
  MEMORY_OUTPUT_FIELD,
  ModelConfigSchema,
  RetrievalConfigSchema,
  derivePorts,
  type DayTotals,
  type Edge,
  type KnowledgeBase,
  type Model,
  type Node,
  type NodeRun,
  type Provider,
  type Run,
  type SearchHit,
  type Usage,
  type Verdict,
} from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { contextChecks } from '../../context/__tests__/context-checks.js';
import { createContextGuard, type ContextGuard } from '../../context/guard.js';
import {
  estimatePartsTokens,
  estimateTokens,
  type SummariseInput,
  type Summariser,
} from '../../envelopes/index.js';
import { createEventBus } from '../../events/index.js';
import { createPolicyService } from '../../guardrails/policy-service.js';
import { guardrailStoreFor } from '../../guardrails/store.js';
import { newId } from '../../ids.js';
import type { SearchService } from '../../knowledge/search.js';
import { createLogger } from '../../logging/index.js';
import { createMemoryService, type MemoryService } from '../../memory/service.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type GenerateRequest,
  type ModelRouter,
  type ProviderAdapter,
  type StreamChunk,
} from '../../ports/index.js';
import { createUsageService } from '../../usage/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import {
  controlStoresFor,
  createRunControls,
  createRunGateRegistry,
  createRunService,
  type BegunRun,
  type RunControls,
  type RunService,
  type RunServiceDeps,
} from '../index.js';

/**
 * The scheduler's round 5 wiring (round 5 §2.2–§2.6, Task 13): the context and memory hooks built
 * per node run, what they record on the node run, the summariser's usage (F5), the envelope budget
 * an agent's retrieval and memory reserve, the day totals on completion, the knowledge-base
 * pre-flight and the run's abort signal reaching the summariser.
 */

const scope = LOCAL_SCOPE;
const NOW = '2026-10-04T10:00:00.000Z';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const KB_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0KBAS';
const PRICING = { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' };

let workflowId: string;

/* -------------------------------------------------------------------------- */
/* Graph                                                                       */
/* -------------------------------------------------------------------------- */

function withPorts<N extends Node>(node: Omit<N, 'inputs' | 'outputs'>): N {
  return { ...node, ...derivePorts(node as Parameters<typeof derivePorts>[0]) } as N;
}

function inputNode(text = 'Ada here, asking about ACE.'): Node {
  return withPorts({
    id: newId(),
    workflowId,
    kind: 'input',
    name: 'Brief',
    position: { x: 0, y: 0 },
    config: { text, artifactIds: [], outputTypes: ['text'] },
  });
}

function agentNode(name: string, config: Record<string, unknown> = {}): Node {
  return withPorts({
    id: newId(),
    workflowId,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    config: AgentConfigSchema.parse({
      providerId: PROVIDER_ID,
      modelId: 'scripted',
      instructions: `Act as ${name}.`,
      inputTypes: ['text'],
      outputTypes: ['text'],
      ...config,
    }),
  });
}

function modelNode(): Node {
  return withPorts({
    id: newId(),
    workflowId,
    kind: 'model',
    name: 'Rewriter',
    position: { x: 0, y: 0 },
    config: ModelConfigSchema.parse({
      providerId: PROVIDER_ID,
      modelId: 'scripted',
      inputTypes: ['text'],
      outputTypes: ['text'],
    }),
  });
}

function retrievalNode(): Node {
  return withPorts({
    id: newId(),
    workflowId,
    kind: 'retrieval',
    name: 'Search',
    position: { x: 0, y: 0 },
    config: RetrievalConfigSchema.parse({ knowledgeBaseId: KB_ID }),
  });
}

function outputNode(): Node {
  return withPorts({
    id: newId(),
    workflowId,
    kind: 'output',
    name: 'Result',
    position: { x: 0, y: 0 },
    config: {},
  });
}

/** A data edge from `from`'s first output to the input port of `to` with the same type. */
function edge(from: Node, to: Node): Edge {
  const out = from.outputs[0]!;
  const into = to.inputs.find((port) => port.dataType === out.dataType) ?? to.inputs[0]!;
  return {
    id: newId(),
    workflowId,
    kind: 'data',
    from: { nodeId: from.id, portId: out.id },
    to: { nodeId: to.id, portId: into.id },
  };
}

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
  outputTypes: ['text', 'json'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: true,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  pricing: PRICING,
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

const say = (text: string): StreamChunk[] => [
  { type: 'text', delta: text },
  { type: 'usage', tokensIn: 2, tokensOut: 3 },
  { type: 'finish', reason: 'stop' },
];

/** `mock-memory`'s answer (§2.10): the answer, and a `save` of the first word of the input. */
const rememberAda = (): StreamChunk[] => [
  {
    type: 'json',
    value: {
      answer: 'Hello, Ada.',
      [MEMORY_OUTPUT_FIELD]: [{ op: 'save', key: 'user_name', value: 'Ada' }],
    },
  },
  { type: 'usage', tokensIn: 2, tokensOut: 3 },
  { type: 'finish', reason: 'stop' },
];

interface Harness {
  service: RunService;
  controls: RunControls;
  repository: FakeRepository;
  memory: MemoryService;
  events: EngineEvent[];
  requests: GenerateRequest[];
  /** What the run service logged at `warn` and above, one JSON line each. */
  logs: string[];
  seed(nodes: Node[], edges: Edge[]): Promise<void>;
  run(): Promise<Run>;
  /** Starts a run and answers as soon as it is under way, with the promise of its end. */
  begin(): Promise<BegunRun>;
  nodeRunOf(run: Run, node: Node): Promise<NodeRun>;
}

let reply: (req: GenerateRequest) => StreamChunk[];
/** When set, a call waits on it before it streams its reply — for a Stop to land mid-call. */
let stall: ((req: GenerateRequest, signal: AbortSignal) => Promise<void>) | undefined;

async function build(
  options: {
    search?: SearchService;
    summariser?: Summariser;
    contextGuard?: ContextGuard;
    usage?: boolean;
    now?: () => string;
    /** The memory the run service is given, made from the real one; answering `undefined` wires none. */
    memory?: (real: MemoryService) => RunServiceDeps['memory'];
    nextId?: () => string;
    /** The project's default guardrail policy, resolved for every node (FR-GRD-002). */
    policies?: boolean;
  } = {},
): Promise<Harness> {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));
  const requests: GenerateRequest[] = [];
  const logs: string[] = [];

  await repository.providers.create(scope, provider);
  await repository.models.replaceForProvider(scope, PROVIDER_ID, [model]);
  await repository.settings.update(scope, { dataDir: '/tmp/ace', concurrency: 4 });
  const kb: KnowledgeBase = {
    id: KB_ID,
    projectId: PROJECT_ID,
    name: 'Handbook',
    embeddingProviderId: PROVIDER_ID,
    embeddingModelId: 'mock-embed',
    chunkSize: 700,
    chunkOverlap: 90,
    documentCount: 0,
    chunkCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await repository.knowledgeBases.insert(scope, kb);

  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(req, signal) {
      requests.push(req);
      const chunks = reply(req);
      return (async function* () {
        await stall?.(req, signal);
        for (const chunk of chunks) yield chunk;
      })();
    },
  };

  const memory = createMemoryService({ scope, repository, bus, now: () => NOW });
  const memoryDep = options.memory === undefined ? memory : options.memory(memory);
  const usage =
    options.usage === true ? createUsageService({ usage: repository.usage, scope }) : undefined;
  const gates = createRunGateRegistry();
  const policies = await (async () => {
    if (options.policies !== true) return undefined;
    await repository.projects.create(scope, {
      id: PROJECT_ID,
      name: 'Project',
      folderPath: '/tmp/ace/project',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const store = guardrailStoreFor(repository, scope);
    return createPolicyService({
      scope,
      policies: store.policies,
      projects: store.projects,
      policyUsage: store.policyUsage,
      checks: contextChecks,
    });
  })();

  const service = createRunService({
    gates,
    repository,
    scope,
    bus,
    logger: createLogger({ level: 'warn', destination: { write: (line) => logs.push(line) } }),
    now: options.now ?? (() => NOW),
    router,
    adapterFor: async () => adapter,
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
    ...(memoryDep === undefined ? {} : { memory: memoryDep }),
    ...(options.search === undefined ? {} : { search: options.search }),
    ...(options.summariser === undefined ? {} : { summariser: options.summariser }),
    ...(options.contextGuard === undefined ? {} : { contextGuard: options.contextGuard }),
    ...(usage === undefined ? {} : { usage }),
    ...(options.nextId === undefined ? {} : { nextId: options.nextId }),
    ...(policies === undefined ? {} : { policies }),
  });

  const controls = createRunControls({
    ...controlStoresFor(repository, scope),
    bus,
    gates,
    driveRecordedRun: (run) => service.driveRecordedRun(run),
    drivePartialRun: (plan) => service.drivePartialRun(plan),
    envelopesFor: (run, nodeId) => service.envelopesFor(run, nodeId),
    ...(usage === undefined ? {} : { usage }),
    ...(options.now === undefined ? { now: () => NOW } : { now: options.now }),
  });

  return {
    service,
    controls,
    repository,
    memory,
    events,
    requests,
    logs,
    async seed(nodes, edges) {
      await repository.workflows.create(scope, {
        id: workflowId,
        projectId: PROJECT_ID,
        name: 'Flow',
        version: 1,
        formatVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      for (const node of nodes) await repository.nodes.insert(scope, node);
      for (const item of edges) await repository.edges.insert(scope, item);
    },
    run: () => service.startRun(workflowId, {}),
    begin: () => service.beginRun(workflowId, {}),
    async nodeRunOf(run, node) {
      const rows = await repository.nodeRuns.listByRun(scope, run.id);
      const row = rows.filter((candidate) => candidate.nodeId === node.id).at(-1);
      if (row === undefined) throw new Error(`no node run for ${node.name}`);
      return row;
    },
  };
}

/** A search that answers fixed hits for the one base, remembering the queries. */
function fakeSearch(hits: SearchHit[]): SearchService & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(kbId, req) {
      queries.push(req.query);
      return { hits: kbId === KB_ID ? hits.slice(0, req.k) : [], tookMs: 1 };
    },
  };
}

function hit(score: number, label: string, chars = 400): SearchHit {
  return {
    chunkId: newId(),
    documentId: '01JBXQ8Z9KQ4R7N2VWXYZ0DOC1',
    text: `Chunk ${label}. ${'lorem ipsum dolor '.repeat(Math.ceil(chars / 18))}`.slice(0, chars),
    score,
    source: `handbook.md#${label}`,
    via: 'both',
  };
}

/** Polls until `predicate` holds, failing after five seconds rather than hanging. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** A summariser that records every call and, for a node with a model, charges for it. */
function recordingSummariser(charge?: Usage): Summariser & {
  calls: (SummariseInput & { target?: { providerId: string; modelId: string } })[];
} {
  const calls: (SummariseInput & { target?: { providerId: string; modelId: string } })[] = [];
  return {
    calls,
    async summarise(input) {
      calls.push(input);
      return {
        parts: [...input.parts],
        ...(charge !== undefined && input.target !== undefined ? { usage: charge } : {}),
      };
    },
  };
}

beforeEach(() => {
  workflowId = newId();
  reply = () => say('ok');
  stall = undefined;
});

/* -------------------------------------------------------------------------- */
/* Envelope budget reservation                                                 */
/* -------------------------------------------------------------------------- */

describe('FR-EXE-007 an agent with knowledge and memory reserves their shares of the envelope budget', () => {
  it('a long upstream output: reads, summary, chunks and memory together stay within budgetTokens', async () => {
    const hits = [0.9, 0.8, 0.7, 0.6, 0.5].map((score) => hit(score, String(score)));
    const h = await build({ search: fakeSearch(hits) });
    const input = inputNode('lorem '.repeat(4000)); // 6000 tokens
    const agent = agentNode('Answerer', {
      knowledgeBaseIds: [KB_ID],
      memory: { enabled: true },
      contextPolicy: { budgetTokens: 1000 },
    });
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    for (const [index, letter] of ['a', 'b', 'c'].entries()) {
      await h.repository.memory.upsert(
        scope,
        agent.id,
        `fact-${letter}`,
        `${letter} `.repeat(100),
        `2026-10-04T09:0${index}:00.000Z`,
        newId,
      );
    }

    const run = await h.run();

    expect(run.status).toBe('COMPLETE');
    const row = await h.nodeRunOf(run, agent);
    const [delivered] = row.inputEnvelopes;
    const readsBudget = Math.floor(
      1000 * (1 - CONTEXT_BUDGET_SHARES.retrieved - CONTEXT_BUDGET_SHARES.memory),
    );
    // The stored envelope is the one the node read (13a review I2): it carries the chunks and the
    // memory, so it states the whole budget they were fitted into — the reads alone still fit the
    // reduced budget they were delivered at.
    expect(delivered?.context.budgetTokens).toBe(1000);
    const readsCost =
      estimatePartsTokens(delivered?.reads ?? []) +
      estimateTokens(delivered?.context.summary ?? '');
    expect(readsCost).toBeLessThanOrEqual(readsBudget);

    // The reservation is what left room for the chunks and the memory.
    expect(row.sources).toHaveLength(5);
    const memory = await h.memory.list(agent.id);
    const used = memory.filter((entry) => entry.lastUsedAt !== undefined);
    expect(used).toHaveLength(3);

    const chunkCost = (row.sources ?? []).reduce(
      (total, source) =>
        total + estimateTokens(hits.find((each) => each.chunkId === source.chunkId)!.text),
      0,
    );
    const memoryCost = used.reduce(
      (total, entry) => total + estimateTokens(entry.key) + estimateTokens(entry.value),
      0,
    );
    expect(readsCost + chunkCost + memoryCost).toBeLessThanOrEqual(1000);
    expect(h.requests[0]?.prompt).toContain('### Retrieved');
    expect(h.requests[0]?.prompt).toContain('### Memory');
  });

  it('an agent with neither keeps the whole budget for its reads, and no context hook output', async () => {
    const h = await build({ search: fakeSearch([hit(0.9, 'x')]) });
    const input = inputNode();
    const agent = agentNode('Plain', { contextPolicy: { budgetTokens: 1000 } });
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const run = await h.run();

    const row = await h.nodeRunOf(run, agent);
    expect(row.inputEnvelopes[0]?.context.budgetTokens).toBe(1000);
    expect(row).not.toHaveProperty('sources');
    expect(row).not.toHaveProperty('droppedSources');
    expect(row).not.toHaveProperty('memoryOps');
    expect(h.requests[0]?.prompt).not.toContain('### Retrieved');
  });
});

/* -------------------------------------------------------------------------- */
/* The summariser: target, usage, signal                                        */
/* -------------------------------------------------------------------------- */

describe('F3 envelopeBetween hands the summariser the receiving node model', () => {
  it('sets the target for an agent or Model node with a provider and model, and none otherwise', async () => {
    const summariser = recordingSummariser();
    const h = await build({ summariser });
    const input = inputNode();
    const agent = agentNode('Writer');
    const rewriter = modelNode();
    const output = outputNode();
    await h.seed(
      [input, agent, rewriter, output],
      [edge(input, agent), edge(agent, rewriter), edge(rewriter, output)],
    );

    const run = await h.run();

    expect(run.status).toBe('COMPLETE');
    expect(summariser.calls.map((call) => call.target)).toEqual([
      { providerId: PROVIDER_ID, modelId: 'scripted' },
      { providerId: PROVIDER_ID, modelId: 'scripted' },
      undefined,
    ]);

    // An agent with no model chosen: what a control rebuilds for it has no target either.
    const unrouted = agentNode('Unrouted', { providerId: undefined, modelId: undefined });
    const extended: Run = {
      ...run,
      snapshot: {
        ...run.snapshot,
        nodes: [...run.snapshot.nodes, unrouted],
        edges: [...run.snapshot.edges, edge(input, unrouted)],
      },
    };
    summariser.calls.length = 0;
    await h.service.envelopesFor(extended, unrouted.id);
    expect(summariser.calls).toHaveLength(1);
    expect(summariser.calls[0]?.target).toBeUndefined();
  });

  it('F5 the summariser usage lands on the receiving node run, and the run totals still sum the node runs', async () => {
    const charge: Usage = {
      tokensIn: 100,
      tokensOut: 10,
      costUsd: 0.25,
      priceTableVersion: 'mock-v1',
    };
    const h = await build({ summariser: recordingSummariser(charge) });
    const input = inputNode();
    const agent = agentNode('Writer');
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const run = await h.run();

    const row = await h.nodeRunOf(run, agent);
    expect(row.usage.tokensIn).toBe(102);
    expect(row.usage.tokensOut).toBe(13);
    expect(row.usage.costUsd).toBeCloseTo(0.25 + 0.000008, 10);
    const rows = await h.repository.nodeRuns.listByRun(scope, run.id);
    const summed = rows.reduce((total, each) => total + each.usage.costUsd, 0);
    expect(run.totals.costUsd).toBeCloseTo(summed, 10);
    expect(run.totals.tokensIn).toBe(102);
  });

  it("forwards the run's own abort signal to the summariser, on delivery and on the start-from path", async () => {
    const summariser = recordingSummariser();
    const h = await build({ summariser });
    const input = inputNode();
    const agent = agentNode('Writer');
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    // The Writer's call lasts until the run is stopped, so each run is still going when it is.
    stall = (_req, signal) =>
      new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));

    const first = await h.begin();
    await waitFor(() => summariser.calls.length === 1, 'Input → Writer to be delivered');
    const delivered = summariser.calls[0]?.signal;
    expect(delivered?.aborted).toBe(false);
    await h.controls.stop(first.run.id);
    await first.done;
    // Stopping the run aborted the very signal the summariser was handed: it is the run's own.
    expect(delivered?.aborted).toBe(true);

    summariser.calls.length = 0;
    const again = await h.service.beginRun(workflowId, { startFromNodeId: agent.id });
    // Input → Writer is rebuilt from the copied Input output (the seed path).
    await waitFor(() => summariser.calls.length === 1, 'the seed path to rebuild Input → Writer');
    const seeded = summariser.calls[0]?.signal;
    expect(seeded?.aborted).toBe(false);
    expect(seeded).not.toBe(delivered);
    await h.controls.stop(again.run.id);
    await again.done;
    expect(seeded?.aborted).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Memory                                                                      */
/* -------------------------------------------------------------------------- */

describe('TC-MEM-001 a memory agent remembers between runs', () => {
  async function memoryFlow(h: Harness): Promise<Node> {
    const input = inputNode();
    const agent = agentNode('Greeter', { outputTypes: ['json'], memory: { enabled: true } });
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    return agent;
  }

  it('the second run reads the remembered fact; the first run records its memoryOps', async () => {
    reply = rememberAda;
    const h = await build();
    const agent = await memoryFlow(h);

    const first = await h.run();
    const firstRow = await h.nodeRunOf(first, agent);
    expect(first.status).toBe('COMPLETE');
    expect(firstRow.memoryOps).toEqual([{ op: 'save', key: 'user_name', value: 'Ada' }]);
    expect(firstRow.output).toEqual([{ type: 'json', value: { answer: 'Hello, Ada.' } }]);
    expect(firstRow.prompt?.text).not.toContain('### Memory');
    expect(
      h.events.some(
        (event) =>
          event.type === 'memory.updated' &&
          (event.payload as { nodeId: string }).nodeId === agent.id,
      ),
    ).toBe(true);

    expect(firstRow.inputEnvelopes[0]?.context).not.toHaveProperty('memory');

    const second = await h.run();
    const secondRow = await h.nodeRunOf(second, agent);
    // The envelope the second run read is stored with the remembered fact (13a review I2).
    expect(secondRow.inputEnvelopes[0]?.context.memory).toEqual([
      { key: 'user_name', value: 'Ada' },
    ]);
    expect(secondRow.prompt?.text).toContain('### Memory');
    expect(secondRow.prompt?.text).toContain('- user_name: Ada');
    const [entry] = await h.memory.list(agent.id);
    expect(entry?.lastUsedAt).toBe(NOW);
  });

  it('TC-MEM-002 after clear, the next run has no memory in its context', async () => {
    reply = rememberAda;
    const h = await build();
    const agent = await memoryFlow(h);
    await h.run();

    await h.memory.clear(agent.id);
    const after = await h.run();

    const row = await h.nodeRunOf(after, agent);
    expect(row.inputEnvelopes[0]?.context).not.toHaveProperty('memory');
    expect(row.prompt?.text).not.toContain('### Memory');
    expect(row.prompt?.text).not.toContain('user_name: Ada');
  });
});

describe('FR-MEM-002 a memory store error after a paid call keeps what the call spent (13a review m1)', () => {
  async function greeterFlow(h: Harness): Promise<Node> {
    const input = inputNode();
    const agent = agentNode('Greeter', { outputTypes: ['json'], memory: { enabled: true } });
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    return agent;
  }

  it('memory ops the store refuses fail the node RUN_FAILED, with its usage on the row and in the run totals', async () => {
    reply = rememberAda;
    const h = await build({
      memory: (real) => ({
        ...real,
        async apply() {
          throw new Error('SQLITE_FULL: database or disk is full');
        },
      }),
    });
    const agent = await greeterFlow(h);

    const run = await h.run();

    const row = await h.nodeRunOf(run, agent);
    expect(row.status).toBe('FAILED');
    expect(row.failureReason).toBe('RUN_FAILED');
    expect(row.error?.code).toBe('memory_not_saved');
    expect(row.usage).toMatchObject({ tokensIn: 2, tokensOut: 3 });
    expect(row.usage.costUsd).toBeGreaterThan(0);
    expect(row.modelUsed?.modelId).toBe('scripted');
    expect(row).not.toHaveProperty('memoryOps');
    expect(run.status).toBe('HALTED');
    expect(run.haltReason).toBe('failure');
    expect(run.totals.tokensIn).toBe(2);
    expect(run.totals.costUsd).toBeCloseTo(row.usage.costUsd, 10);
    expect(await h.memory.list(agent.id)).toEqual([]);
  });

  it('a lastUsedAt stamp that fails is logged and never fails the node', async () => {
    reply = rememberAda;
    const h = await build({
      memory: (real) => ({
        ...real,
        async markUsed() {
          throw new Error('SQLITE_BUSY: database is locked');
        },
      }),
    });
    const agent = await greeterFlow(h);
    await h.repository.memory.upsert(scope, agent.id, 'tone', 'brief', NOW, newId);

    const run = await h.run();

    expect(run.status).toBe('COMPLETE');
    const row = await h.nodeRunOf(run, agent);
    expect(row.status).toBe('COMPLETED');
    expect(row.inputEnvelopes[0]?.context.memory).toEqual([{ key: 'tone', value: 'brief' }]);
    expect(row.usage).toMatchObject({ tokensIn: 2, tokensOut: 3 });
    expect(h.logs.some((line) => line.includes('could not mark memory entries used'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Knowledge                                                                   */
/* -------------------------------------------------------------------------- */

describe('TC-RAG-006 an agent with an attached knowledge base', () => {
  it('records its sources and reads the chunks as envelope.context.retrieved', async () => {
    const hits = [hit(0.9, 'first', 200), hit(0.4, 'second', 200)];
    const search = fakeSearch(hits);
    const h = await build({ search });
    const input = inputNode('What is ACE?');
    const agent = agentNode('Answerer', { knowledgeBaseIds: [KB_ID] });
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const run = await h.run();

    const row = await h.nodeRunOf(run, agent);
    expect(search.queries).toEqual(['What is ACE?']);
    expect(row.sources?.map((source) => source.chunkId)).toEqual(hits.map((each) => each.chunkId));
    expect(row).not.toHaveProperty('droppedSources');
    expect(row.prompt?.text).toContain('### Retrieved');
    expect(row.prompt?.text).toContain('Chunk first.');
    // The envelope the agent read is stored with what was retrieved (13a review I2).
    expect(row.inputEnvelopes[0]?.context.retrieved).toEqual(
      hits.map(({ chunkId, text, score, source }) => ({ chunkId, text, score, source })),
    );
    expect(row.inputEnvelopes[0]?.context.trust).toBe('untrusted');
  });

  it('stores a key-shaped string in a retrieved chunk masked, as the stored prompt is (BR-07)', async () => {
    // Assembled at runtime: a key-shaped literal in a repository file is what CLAUDE.md §2 forbids.
    const key = ['sk', 'ant', 'a'.repeat(32)].join('-');
    const leaky = { ...hit(0.9, 'leaky', 100), text: `The deploy key is ${key} for now.` };
    const h = await build({ search: fakeSearch([leaky]) });
    const input = inputNode('What is the deploy key?');
    const agent = agentNode('Answerer', { knowledgeBaseIds: [KB_ID] });
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const run = await h.run();

    expect(run.status).toBe('COMPLETE');
    const row = await h.nodeRunOf(run, agent);
    expect(JSON.stringify(row.inputEnvelopes)).not.toContain(key);
    expect(row.inputEnvelopes[0]?.context.retrieved?.[0]?.text).toBe(
      'The deploy key is [REDACTED] for now.',
    );
    expect(row.prompt?.text).not.toContain(key);
  });

  it('a context step that fails leaves the delivered envelope stored as it was', async () => {
    const search: SearchService = {
      async search() {
        throw new Error('the embedder is unreachable');
      },
    };
    const h = await build({ search });
    const input = inputNode('What is ACE?');
    const agent = agentNode('Answerer', { knowledgeBaseIds: [KB_ID] });
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const run = await h.run();

    const row = await h.nodeRunOf(run, agent);
    expect(row.status).toBe('FAILED');
    expect(row.inputEnvelopes[0]?.context).toEqual({ budgetTokens: 2000, trust: 'trusted' });
  });
});

describe('13a review m7 the production composition keeps round 4 behaviour for a plain agent', () => {
  /** ULIDs from a counter, so two runs built alike get the same ids and compare byte for byte. */
  const countingIds = (): (() => string) => {
    let next = 0;
    return () => `01JBXQ8Z9KQ4R7N2VW${String(next++).padStart(8, '0')}`;
  };

  it('with the context guard, search and memory wired and no findings, stores the same envelopes and prompts', async () => {
    reply = (req) =>
      req.prompt.includes('Act as Writer.') ? say('A short draft about ACE.') : say('Polished.');
    const input = inputNode('Write about ACE, briefly.');
    const writer = agentNode('Writer');
    const rewriter = modelNode();
    const output = outputNode();
    const nodes = [input, writer, rewriter, output];
    const edges = [edge(input, writer), edge(writer, rewriter), edge(rewriter, output)];

    /** One run of the graph; what each node read and was prompted with. */
    async function rowsOf(h: Harness) {
      await h.seed(nodes, edges);
      const run = await h.run();
      expect(run.status).toBe('COMPLETE');
      return Promise.all(
        [writer, rewriter, output].map(async (node) => {
          const row = await h.nodeRunOf(run, node);
          return { inputEnvelopes: row.inputEnvelopes, prompt: row.prompt };
        }),
      );
    }

    // The round 5 services as the server composes them: the real context guard over the project's
    // default policy and the same check runner, a search, and the memory service.
    const recorded: unknown[] = [];
    const judged: string[] = [];
    const composed = await build({
      policies: true,
      nextId: countingIds(),
      search: fakeSearch([hit(0.9, 'never searched')]),
      contextGuard: createContextGuard({
        policies: { resolve: async () => null },
        evaluator: {
          evaluate(check, input) {
            judged.push(check.type);
            return contextChecks.evaluate(check, input);
          },
        },
        record: async (_target, verdict) => {
          recorded.push(verdict);
          return verdict;
        },
      }),
    });
    const plain = await build({
      policies: true,
      nextId: countingIds(),
      memory: () => undefined,
    });

    const withRoundFive = await rowsOf(composed);
    const withoutRoundFive = await rowsOf(plain);

    expect(recorded).toEqual([]);
    expect(judged).toEqual(
      expect.arrayContaining(['untrusted_tagging', 'prompt_injection', 'pii']),
    );
    expect(JSON.stringify(withRoundFive)).toBe(JSON.stringify(withoutRoundFive));
    // And the comparison is not vacuous: the reads were there to be judged.
    expect(withRoundFive[1]?.prompt?.text).toContain('A short draft about ACE.');
    expect(withRoundFive[1]?.inputEnvelopes[0]?.context.trust).toBe('untrusted');
  });
});

describe('13a review I2 a plain agent keeps its delivered envelopes byte for byte', () => {
  it('with a context guard rewriting an upstream read, the stored envelope is still the delivered one', async () => {
    const guard: ContextGuard = {
      async inspect({ text }) {
        return { kind: 'continue', text: text.toUpperCase(), verdicts: [] };
      },
      async record(_target, verdicts) {
        return [...verdicts];
      },
      async sanitise() {
        throw new Error('the builder judges and records apart');
      },
      async checkIngestText({ text }) {
        return { text, verdicts: [] };
      },
    };
    reply = (req) => (req.prompt.includes('Act as Writer.') ? say('lower case draft') : say('ok'));
    const h = await build({ contextGuard: guard, search: fakeSearch([hit(0.9, 'unused')]) });
    const input = inputNode();
    const writer = agentNode('Writer');
    const editor = agentNode('Editor');
    const output = outputNode();
    await h.seed(
      [input, writer, editor, output],
      [edge(input, writer), edge(writer, editor), edge(editor, output)],
    );

    const run = await h.run();

    expect(run.status).toBe('COMPLETE');
    const row = await h.nodeRunOf(run, editor);
    // The prompt read the guarded text; the stored envelope is the one delivered, untouched.
    expect(row.prompt?.text).toContain('LOWER CASE DRAFT');
    expect(row.inputEnvelopes).toHaveLength(1);
    expect(row.inputEnvelopes[0]?.reads).toEqual([{ type: 'text', text: 'lower case draft' }]);
    expect(row.inputEnvelopes[0]?.context).toEqual({ budgetTokens: 4000, trust: 'untrusted' });
  });
});

/**
 * A search that answers only after `ms`, unless the signal it is handed aborts first; it remembers
 * the signals and says when it started.
 */
function slowSearch(
  ms: number,
  hits: SearchHit[],
): SearchService & { started: Promise<void>; signals: (AbortSignal | undefined)[] } {
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const signals: (AbortSignal | undefined)[] = [];
  return {
    started,
    signals,
    search(_kbId, req, options?: { signal?: AbortSignal }) {
      const signal = options?.signal;
      signals.push(signal);
      markStarted();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ hits: hits.slice(0, req.k), tookMs: ms }), ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
}

describe('FR-CTL-003 a Stop during the context step (13a review m3)', () => {
  it('ends the node STOPPED promptly, with no markUsed, no context verdict and no call', async () => {
    const recorded: Verdict[] = [];
    // Every retrieved chunk and memory entry is a finding, so a context step that ran on would
    // leave verdicts behind.
    const guard: ContextGuard = {
      async inspect({ target, label, text }) {
        if (label === 'upstream') return { kind: 'continue', text, verdicts: [] };
        const verdict = { id: newId(), nodeRunId: target.nodeRunId } as unknown as Verdict;
        return { kind: 'continue', text, verdicts: [verdict] };
      },
      async record(_target, verdicts) {
        recorded.push(...verdicts);
        return [...verdicts];
      },
      async sanitise() {
        throw new Error('the builder judges and records apart');
      },
      async checkIngestText({ text }) {
        return { text, verdicts: [] };
      },
    };
    const search = slowSearch(2_000, [hit(0.9, 'slow', 100)]);
    const marked: string[][] = [];
    const h = await build({
      search,
      contextGuard: guard,
      memory: (real) => ({
        ...real,
        async markUsed(ids) {
          marked.push([...ids]);
          await real.markUsed(ids);
        },
      }),
    });
    const input = inputNode('What is ACE?');
    const agent = agentNode('Answerer', { knowledgeBaseIds: [KB_ID], memory: { enabled: true } });
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);
    await h.repository.memory.upsert(scope, agent.id, 'tone', 'brief', NOW, newId);

    const begun = await h.begin();
    await search.started;
    const stoppedAt = Date.now();
    await h.controls.stop(begun.run.id);
    const ended = await begun.done;

    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
    expect(ended.status).toBe('HALTED');
    expect(ended.haltReason).toBe('stopped');
    const row = await h.nodeRunOf(ended, agent);
    expect(row.status).toBe('STOPPED');
    expect(row.error?.kind).toBe('user_cancelled');
    expect(row).not.toHaveProperty('sources');
    // The search was handed the run's own signal, which the Stop aborted.
    expect(search.signals).toHaveLength(1);
    expect(search.signals[0]?.aborted).toBe(true);
    expect(marked).toEqual([]);
    expect((await h.memory.list(agent.id))[0]?.lastUsedAt).toBeUndefined();
    expect(recorded).toEqual([]);
    expect(h.requests).toHaveLength(0);
  });
});

describe('FR-RAG-006 a Retrieval node run', () => {
  it('records its sources and hands its hits on', async () => {
    const hits = [hit(0.9, 'only', 100)];
    const h = await build({ search: fakeSearch(hits) });
    const input = inputNode('What is ACE?');
    const retrieval = retrievalNode();
    const output = outputNode();
    await h.seed([input, retrieval, output], [edge(input, retrieval), edge(retrieval, output)]);

    const run = await h.run();

    expect(run.status).toBe('COMPLETE');
    const row = await h.nodeRunOf(run, retrieval);
    expect(row.sources).toEqual([
      {
        chunkId: hits[0]!.chunkId,
        documentId: hits[0]!.documentId,
        score: 0.9,
        source: 'handbook.md#only',
      },
    ]);
    expect(Object.values(run.finalOutput ?? {})).toEqual([[{ type: 'json', value: { hits } }]]);
  });
});

describe('§2.4 pre-flight looks up an attached knowledge base', () => {
  it('blocks a run whose agent names a base that no longer exists, with no provider call', async () => {
    const h = await build({ search: fakeSearch([]) });
    const input = inputNode();
    const agent = agentNode('Answerer', { knowledgeBaseIds: ['01JBXQ8Z9KQ4R7N2VWXYZ0G0NE'] });
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const run = await h.run();

    expect(run.status).toBe('BLOCKED');
    expect(run.preflightIssues.map((issue) => issue.code)).toContain('missing_knowledge_base');
    expect(h.requests).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The context guard                                                           */
/* -------------------------------------------------------------------------- */

describe('FR-GRD-004 the context guard judges an upstream output for the node run reading it', () => {
  it("strips what it finds before the Model node's prompt, recording against that node run", async () => {
    const recorded: { nodeRunId: string; verdicts: readonly Verdict[] }[] = [];
    const guard: ContextGuard = {
      async inspect({ target, text }) {
        if (!text.includes('POISON')) return { kind: 'continue', text, verdicts: [] };
        const verdict = { id: newId(), nodeRunId: target.nodeRunId } as unknown as Verdict;
        return { kind: 'continue', text: text.replaceAll('POISON', ''), verdicts: [verdict] };
      },
      async record(target, verdicts) {
        recorded.push({ nodeRunId: target.nodeRunId, verdicts });
        return [...verdicts];
      },
      async sanitise() {
        throw new Error('the builder judges and records apart');
      },
      async checkIngestText({ text }) {
        return { text, verdicts: [] };
      },
    };
    reply = (req) => (req.prompt.includes('Act as Writer.') ? say('POISON draft') : say('clean'));
    const h = await build({ contextGuard: guard });
    const input = inputNode();
    const writer = agentNode('Writer');
    const rewriter = modelNode();
    const output = outputNode();
    await h.seed(
      [input, writer, rewriter, output],
      [edge(input, writer), edge(writer, rewriter), edge(rewriter, output)],
    );

    const run = await h.run();

    expect(run.status).toBe('COMPLETE');
    const rewriterRow = await h.nodeRunOf(run, rewriter);
    expect(rewriterRow.prompt?.text).not.toContain('POISON');
    expect(rewriterRow.prompt?.text).toContain('draft');
    expect(recorded).toEqual([
      {
        nodeRunId: rewriterRow.id,
        verdicts: [expect.objectContaining({ nodeRunId: rewriterRow.id })],
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Day totals                                                                  */
/* -------------------------------------------------------------------------- */

describe('FR-OBS-002 a completed run announces the day totals', () => {
  it('emits usage.updated with dayTotals, before run.completed, when a usage service is wired', async () => {
    const h = await build({ usage: true });
    const input = inputNode();
    const agent = agentNode('Writer');
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const run = await h.run();

    const withDay = h.events.filter(
      (event) =>
        event.type === 'usage.updated' &&
        (event.payload as { dayTotals?: DayTotals }).dayTotals !== undefined,
    );
    expect(withDay).toHaveLength(1);
    const payload = withDay[0]!.payload as { runId: string; totals: Usage; dayTotals: DayTotals };
    expect(payload.runId).toBe(run.id);
    expect(payload.totals).toEqual(run.totals);
    expect(payload.dayTotals.day).toBe(NOW.slice(0, 10));
    expect(payload.dayTotals.totals.tokensIn).toBe(2);
    const completed = h.events.findIndex((event) => event.type === 'run.completed');
    expect(h.events.indexOf(withDay[0]!)).toBeLessThan(completed);
  });

  it('emits no dayTotals without a usage service', async () => {
    const h = await build();
    const input = inputNode();
    const agent = agentNode('Writer');
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    await h.run();

    expect(
      h.events.some(
        (event) =>
          event.type === 'usage.updated' &&
          (event.payload as { dayTotals?: DayTotals }).dayTotals !== undefined,
      ),
    ).toBe(false);
  });
});

describe('FR-OBS-002 every run ending with spend announces the day totals (13a review m5)', () => {
  type UsagePayload = { runId: string; totals: Usage; dayTotals?: DayTotals };

  /** The `usage.updated` frames of one run that carry day totals, and where its `run.completed` is. */
  function dayFrames(h: Harness, runId: string) {
    const frames = h.events
      .map((event, index) => ({ event, index }))
      .filter(
        ({ event }) =>
          event.type === 'usage.updated' &&
          (event.payload as UsagePayload).runId === runId &&
          (event.payload as UsagePayload).dayTotals !== undefined,
      );
    const completed = h.events.findIndex(
      (event) =>
        event.type === 'run.completed' && (event.payload as { runId: string }).runId === runId,
    );
    return {
      frames: frames.map(({ event, index }) => ({ payload: event.payload as UsagePayload, index })),
      completed,
    };
  }

  async function writerReviewer(h: Harness): Promise<{ writer: Node; reviewer: Node }> {
    const input = inputNode();
    const writer = agentNode('Writer');
    const reviewer = agentNode('Reviewer');
    const output = outputNode();
    await h.seed(
      [input, writer, reviewer, output],
      [edge(input, writer), edge(writer, reviewer), edge(reviewer, output)],
    );
    return { writer, reviewer };
  }

  it('a Stop through the controls: before its run.completed, and the last one counts what the run spent', async () => {
    const h = await build({ usage: true });
    await writerReviewer(h);
    // The Reviewer's call is under way when the Stop lands; it reports its usage as its stream closes.
    let reviewing: () => void = () => undefined;
    const reviewerCalled = new Promise<void>((resolve) => {
      reviewing = resolve;
    });
    stall = async (req, signal) => {
      if (!req.prompt.includes('Act as Reviewer.')) return;
      reviewing();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
    };

    const begun = await h.begin();
    await reviewerCalled;
    await h.controls.stop(begun.run.id);
    const ended = await begun.done;

    expect(ended.status).toBe('HALTED');
    expect(ended.haltReason).toBe('stopped');
    const { frames, completed } = dayFrames(h, begun.run.id);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.index).toBeLessThan(completed);
    expect(frames[0]!.payload.dayTotals?.day).toBe(NOW.slice(0, 10));
    // Whatever landed after the Stop summed the run, the last day totals announced count it all.
    const last = frames.at(-1)!.payload;
    expect(last.totals).toEqual(ended.totals);
    expect(last.dayTotals?.totals.tokensIn).toBe(ended.totals.tokensIn);
    expect(ended.totals.tokensIn).toBeGreaterThan(0);
  });

  it('an FR-EXE-011 failure ending — the drive itself threw — before its run.completed', async () => {
    const h = await build({ usage: true });
    await writerReviewer(h);
    // The store refuses the drive's own end-of-run write, once; the run is halted after the throw.
    const update = h.repository.runs.update;
    let refused = false;
    h.repository.runs.update = async (...args: Parameters<typeof update>) => {
      if (!refused && args[2].finalOutput !== undefined) {
        refused = true;
        throw new Error('SQLITE_IOERR: disk I/O error');
      }
      return update(...args);
    };

    const ended = await h.run();

    expect(refused).toBe(true);
    expect(ended.status).toBe('HALTED');
    expect(ended.haltReason).toBe('failure');
    const { frames, completed } = dayFrames(h, ended.id);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.index).toBeLessThan(completed);
    expect(frames[0]!.payload.totals).toEqual(ended.totals);
    expect(frames[0]!.payload.dayTotals?.totals.tokensIn).toBe(4);
  });

  it('a restarted run: its own drive ends with the day totals', async () => {
    const h = await build({ usage: true });
    await writerReviewer(h);
    const first = await h.run();

    const restarted = await h.controls.restart(first.id);
    await waitFor(() => dayFrames(h, restarted.id).completed !== -1, 'the restart to end');

    const { frames, completed } = dayFrames(h, restarted.id);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.index).toBeLessThan(completed);
    // Both runs are today's: 2 tokens in per agent call, four calls.
    expect(frames[0]!.payload.dayTotals?.totals.tokensIn).toBe(8);
  });

  it('a re-run of one node (a partial drive): the reopened run ends with the day totals again', async () => {
    const h = await build({ usage: true });
    const { reviewer } = await writerReviewer(h);
    const run = await h.run();
    const before = dayFrames(h, run.id).frames.length;

    await h.controls.rerunNode(run.id, reviewer.id);
    await waitFor(
      () =>
        h.events.filter(
          (event) =>
            event.type === 'run.completed' && (event.payload as { runId: string }).runId === run.id,
        ).length === 2,
      'the re-run to end',
    );

    const { frames } = dayFrames(h, run.id);
    expect(frames).toHaveLength(before + 1);
    expect(frames.at(-1)!.payload.dayTotals?.totals.tokensIn).toBe(6);
  });
});

/* -------------------------------------------------------------------------- */
/* Node-run duration                                                           */
/* -------------------------------------------------------------------------- */

describe('F10 / FR-OBS-007 a node run records how long it ran', () => {
  it('durationMs is endedAt − startedAt on a completed agent node run', async () => {
    let tick = 0;
    const clock = (): string => new Date(Date.UTC(2026, 9, 4, 10, 0, 0, tick++ * 10)).toISOString();
    const h = await build({ now: clock });
    const input = inputNode();
    const agent = agentNode('Writer');
    const output = outputNode();
    await h.seed([input, agent, output], [edge(input, agent), edge(agent, output)]);

    const run = await h.run();

    expect(run.status).toBe('COMPLETE');
    const row = await h.nodeRunOf(run, agent);
    expect(row.startedAt).toBeDefined();
    expect(row.endedAt).toBeDefined();
    expect(row.durationMs).toBe(Date.parse(row.endedAt ?? '') - Date.parse(row.startedAt ?? ''));
    expect(row.durationMs).toBeGreaterThan(0);
  });
});
