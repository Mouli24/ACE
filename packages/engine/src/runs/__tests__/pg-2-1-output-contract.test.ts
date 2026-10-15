/**
 * PG-2.1 Output contracts are enforced (docs/team-prompts/product-gaps-fix-prompt.md, X4).
 *
 * Phase 0 red tests. A JSON schema on a node implies JSON output: the engine must treat
 * `outputContract.jsonSchema` as `outputTypes ⊇ ['json']` in the executor, in envelope building
 * and in graph validation. Today the executor parses and checks JSON only when `outputTypes` has
 * `json` (`runs/executor.ts` ~1422), so an Agent left at the default `['text']` with a schema is
 * never checked, and a Review→Fix loop from such a node is refused `loop_source_not_json`.
 *
 * Blocked combinations get named validation issues (the code names are the fix's to choose):
 * a schema on a model with `supportsJson: false`, and tools on a model with `supportsTools: false`
 * — which the executor drops silently today (`executor.ts` ~755, ~977).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentConfigSchema,
  type Edge,
  type Envelope,
  type GraphOpsResponse,
  type Model,
  type Node,
  type Provider,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createEventBus } from '../../events/index.js';
import { validateGraph } from '../../graph/validate.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type ModelRouter,
  type ProviderAdapter,
  type StreamChunk,
} from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import {
  addEdge,
  addNode,
  agentNode as helperAgent,
  createHarness,
  createProject,
  createWorkflow,
  edgeBetween,
  graphOps,
  inputNode as helperInput,
} from '../../__tests__/graph-helpers.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createNodeExecutor } from '../executor.js';
import { preflight } from '../preflight.js';

const NOW = '2026-10-15T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const UPSTREAM = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';

const SCHEMA = { type: 'object', required: ['verdict', 'score'] };

const agent = (config: Record<string, unknown> = {}): Node => ({
  id: NODE_ID,
  workflowId: WORKFLOW_ID,
  kind: 'agent',
  name: 'Reviewer',
  position: { x: 0, y: 0 },
  inputs: [{ id: `${NODE_ID}:in:text`, name: 'text', dataType: 'text', multi: false }],
  outputs: [{ id: `${NODE_ID}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: AgentConfigSchema.parse({
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    instructions: 'Review the draft.',
    inputTypes: ['text'],
    outputTypes: ['text'],
    ...config,
  }),
});

const envelope: Envelope = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0ENVP',
  runId: RUN_ID,
  fromNodeId: UPSTREAM,
  toNodeId: NODE_ID,
  iteration: 1,
  reads: [{ type: 'text', text: 'the draft' }],
  context: { budgetTokens: 4000, trust: 'untrusted' },
  contract: { outputTypes: ['text'] },
  createdAt: NOW,
};

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
  ...overrides,
});

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

async function execute(node: Node, reply: string) {
  const repository = new FakeRepository();
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
    now: () => NOW,
  });
  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate: () =>
      (async function* (): AsyncGenerator<StreamChunk> {
        await Promise.resolve();
        yield { type: 'text', delta: reply };
        yield { type: 'usage', tokensIn: 1, tokensOut: 3 };
        yield { type: 'finish', reason: 'stop' };
      })(),
  };
  const route = {
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    viaFallback: false,
  };
  const router: ModelRouter = {
    resolve: () => ({ ok: true, route }),
    resolveForBench: () => ({ ok: true, route }),
  };
  const executor = createNodeExecutor({
    bus,
    logger: createLogger({
      level: 'silent',
      destination: { write: () => undefined },
    }),
    now: () => NOW,
    adapterFor: async () => adapter,
    modelsFor: async () => [model()],
    router,
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
  });
  return executor.execute({
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
}

describe('PG-2.1 a schema implies JSON output in the executor', () => {
  it.fails(
    'outputTypes [text] + a schema: non-conforming output is CONTRACT_VIOLATION',
    async () => {
      const outcome = await execute(
        agent({ outputContract: { jsonSchema: SCHEMA } }),
        '{"verdict":"approved"}',
      );

      expect(outcome.status).toBe('FAILED');
      expect(outcome.failureReason).toBe('CONTRACT_VIOLATION');
    },
  );

  it.fails(
    'outputTypes [text] + a schema: prose that is not JSON at all is CONTRACT_VIOLATION',
    async () => {
      const outcome = await execute(
        agent({ outputContract: { jsonSchema: SCHEMA } }),
        'Looks good to me.',
      );

      expect(outcome.failureReason).toBe('CONTRACT_VIOLATION');
    },
  );

  it.fails(
    'outputTypes [text] + a schema: conforming output is parsed into a json part',
    async () => {
      const outcome = await execute(
        agent({ outputContract: { jsonSchema: SCHEMA } }),
        '{"verdict":"approved","score":8}',
      );

      expect(outcome.status).toBe('COMPLETED');
      expect(outcome.output).toContainEqual({
        type: 'json',
        value: { verdict: 'approved', score: 8 },
      });
    },
  );

  it('control: outputTypes [text] with no schema stays free text (passes today)', async () => {
    const outcome = await execute(agent(), 'Looks good to me.');

    expect(outcome.status).toBe('COMPLETED');
    expect(outcome.output).toEqual([{ type: 'text', text: 'Looks good to me.' }]);
  });
});

describe('PG-2.1 a Review→Fix loop from a node with a schema is accepted', () => {
  it.fails(
    'graph-ops accept a loop edge whose source has a schema but outputTypes [text]',
    async () => {
      const h = createHarness();
      const dir = mkdtempSync(join(tmpdir(), 'ace-pg21-'));
      try {
        const project = await createProject(h.app, join(dir, 'project'));
        const workflow = await createWorkflow(h.app, project.id);
        const input = helperInput(workflow.id);
        const writer = helperAgent(workflow.id, ['text'], ['text']);
        const base = helperAgent(workflow.id, ['text'], ['text']);
        const reviewer: Node =
          base.kind === 'agent'
            ? {
                ...base,
                config: {
                  ...base.config,
                  outputContract: { jsonSchema: SCHEMA },
                },
              }
            : base;

        const seeded = await graphOps(h.app, workflow.id, 0, [
          addNode(input),
          addNode(writer),
          addNode(reviewer),
          addEdge(edgeBetween(workflow.id, input.id, 'text', writer.id, 'text')),
          addEdge(edgeBetween(workflow.id, writer.id, 'text', reviewer.id, 'text')),
        ]);
        expect(seeded.status).toBe(200);
        const { version } = (await seeded.json()) as GraphOpsResponse;

        const loop: Edge = {
          ...edgeBetween(workflow.id, reviewer.id, 'text', writer.id, 'text'),
          kind: 'loop',
          loop: {
            maxIterations: 3,
            exitCondition: { path: 'verdict', equals: 'approved' },
            onMax: 'continue',
          },
        };
        const response = await graphOps(h.app, workflow.id, version, [addEdge(loop)]);

        // The refusal body (today `loop_source_not_json`) rides the assertion message.
        expect(response.status, await response.clone().text()).toBe(200);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('PG-2.1 blocked combinations are named validation issues', () => {
  const errorsFor = (node: Node, catalog: Model) =>
    validateGraph([node], [], {
      providers: [provider],
      models: [catalog],
    }).filter((issue) => issue.severity === 'error' && issue.nodeId === NODE_ID);

  it.fails('a schema on a model with supportsJson:false is an error on the node (validate)', () => {
    const issues = errorsFor(
      agent({ outputContract: { jsonSchema: SCHEMA } }),
      model({ supportsJson: false }),
    );

    expect(issues.length).toBeGreaterThan(0);
  });

  it.fails(
    'tools enabled on a model with supportsTools:false is an error on the node (validate)',
    () => {
      const issues = errorsFor(
        agent({
          tools: {
            enabled: ['read_file'],
            maxToolCalls: 5,
            allowedDomains: [],
          },
        }),
        model({ supportsTools: false }),
      );

      expect(issues.length).toBeGreaterThan(0);
    },
  );

  it.fails('pre-flight blocks the same schema + supportsJson:false node', async () => {
    const node = agent({ outputContract: { jsonSchema: SCHEMA } });
    const issues = await preflight({
      nodes: [node],
      edges: [],
      inputs: {},
      providers: [provider],
      models: [model({ supportsJson: false })],
      checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
      knowledgeBaseExists: async () => true,
      embeddingProviderOf: async () => undefined,
    });

    expect(
      issues.filter((issue) => issue.nodeId === NODE_ID && issue.severity === 'error'),
    ).not.toEqual([]);
  });

  it('control: the same nodes on a capable model raise no node error (passes today)', async () => {
    const capable = model({ supportsJson: true, supportsTools: true });
    const preflighted = await preflight({
      nodes: [agent({ outputContract: { jsonSchema: SCHEMA } })],
      edges: [],
      inputs: {},
      providers: [provider],
      models: [capable],
      checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
      knowledgeBaseExists: async () => true,
      embeddingProviderOf: async () => undefined,
    });
    expect(
      preflighted.filter((issue) => issue.nodeId === NODE_ID && issue.severity === 'error'),
    ).toEqual([]);
    expect(errorsFor(agent({ outputContract: { jsonSchema: SCHEMA } }), capable)).toEqual([]);
    expect(
      errorsFor(
        agent({
          tools: {
            enabled: ['read_file'],
            maxToolCalls: 5,
            allowedDomains: [],
          },
        }),
        capable,
      ),
    ).toEqual([]);
  });
});
