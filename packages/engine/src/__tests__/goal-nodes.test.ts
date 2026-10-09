import { AgentConfigSchema, type Edge, type Model, type Node, type Provider } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { NodeRunTurn } from '../chat/service.js';
import { AceNodeError } from '../errors/index.js';
import { createEventBus } from '../events/index.js';
import { validateGraph } from '../graph/validate.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type ModelRouter,
  type ProviderAdapter,
} from '../ports/index.js';
import { createRunGateRegistry, createRunService, type RunService } from '../runs/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

/**
 * Goal-driven nodes (D285): a workflow can be nothing but Agent nodes, each told what to achieve.
 * No Input node is needed to start it — a node with no upstream starts from its own goal — and no
 * Output node is needed to finish it: the run is COMPLETE when every node nothing is downstream of
 * has completed. Each finished node hands its goal and result to its chat session before its final
 * state is announced.
 */

const scope = LOCAL_SCOPE;
const NOW = '2026-10-09T10:00:00.000Z';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

let workflowId: string;

const port = (nodeId: string, dir: 'in' | 'out', name = 'text', multi = false) => ({
  id: `${nodeId}:${dir}:${name}`,
  name,
  dataType: 'text' as const,
  multi,
});

function agent(name: string, goal: string, config: Record<string, unknown> = {}): Node {
  const id = newId();
  return {
    id,
    workflowId,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    inputs: [port(id, 'in')],
    outputs: [port(id, 'out', 'text', true)],
    config: AgentConfigSchema.parse({
      providerId: PROVIDER_ID,
      modelId: 'scripted',
      instructions: goal,
      inputTypes: ['text'],
      outputTypes: ['text'],
      execution: {
        temperature: 0.2,
        maxTokens: 500,
        timeoutMs: 30_000,
        retries: 0,
      },
      ...config,
    }),
  };
}

function output(name = 'Result'): Node {
  const id = newId();
  return {
    id,
    workflowId,
    kind: 'output',
    name,
    position: { x: 0, y: 0 },
    inputs: [port(id, 'in')],
    outputs: [],
    config: {},
  };
}

const edge = (from: Node, to: Node): Edge => ({
  id: newId(),
  workflowId,
  kind: 'data',
  from: { nodeId: from.id, portId: from.outputs[0]!.id },
  to: { nodeId: to.id, portId: to.inputs[0]!.id },
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

const model: Model = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
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

let prompts: string[];
let behaviour: (prompt: string) => { text?: string; throws?: unknown };

function adapter(): ProviderAdapter {
  return {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(req) {
      return (async function* () {
        prompts.push(req.prompt);
        await Promise.resolve();
        const result = behaviour(req.prompt);
        if (result.throws !== undefined) throw result.throws;
        yield { type: 'model' as const, modelId: 'scripted-2026' };
        yield { type: 'text' as const, delta: result.text ?? 'ok' };
        yield { type: 'usage' as const, tokensIn: 2, tokensOut: 3 };
        yield { type: 'finish' as const, reason: 'stop' as const };
      })();
    },
  };
}

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

let service: RunService;
let repository: FakeRepository;
let events: EngineEvent[];
let turns: NodeRunTurn[];
/** The event count at the moment each turn was recorded — to prove it lands before the state. */
let eventsWhenRecorded: number[];

async function seed(nodes: Node[], edges: Edge[]): Promise<void> {
  await repository.workflows.create(scope, {
    id: workflowId,
    projectId: '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC',
    name: 'Goals',
    version: 1,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  for (const node of nodes) await repository.nodes.insert(scope, node);
  for (const each of edges) await repository.edges.insert(scope, each);
}

beforeEach(async () => {
  workflowId = newId();
  prompts = [];
  turns = [];
  eventsWhenRecorded = [];
  behaviour = () => ({ text: 'ok' });
  repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });
  events = [];
  await bus.subscribe((event) => events.push(event));
  await repository.providers.create(scope, provider);
  await repository.models.replaceForProvider(scope, PROVIDER_ID, [model]);
  await repository.settings.update(scope, {
    dataDir: '/tmp/ace',
    concurrency: 20,
  });

  service = createRunService({
    gates: createRunGateRegistry(),
    repository,
    scope,
    bus,
    logger: createLogger({
      level: 'silent',
      destination: { write: () => undefined },
    }),
    now: () => NOW,
    router,
    adapterFor: async () => adapter(),
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    runGated: async (_providerId, fn) => fn(),
    tokenBatchMs: 0,
    recordNodeTurn: async (turn) => {
      turns.push(turn);
      eventsWhenRecorded.push(events.length);
    },
  });
});

describe('D285 the graph rules for goal-driven nodes', () => {
  const codes = (nodes: Node[], edges: Edge[] = []) =>
    validateGraph(nodes, edges).map((issue) => [issue.code, issue.nodeId]);

  it('accepts a single Agent with a goal: no Input, no Output, no incoming edge needed', () => {
    workflowId = newId();
    expect(codes([agent('Poet', 'Write a haiku about rain.')])).toEqual([]);
  });

  it('accepts a chain of goal-driven Agents', () => {
    workflowId = newId();
    const writer = agent('Writer', 'Write a haiku.');
    const critic = agent('Critic', 'Critique the haiku you are given.');
    expect(codes([writer, critic], [edge(writer, critic)])).toEqual([]);
  });

  it('says an empty workflow has nothing to start from, and does not ask for an Output node', () => {
    const issues = codes([]);
    expect(issues.map(([code]) => code)).toContain('no_input_node');
    expect(issues.map(([code]) => code)).not.toContain('no_output_node');
  });

  it('flags a starting Agent that has no goal, naming it', () => {
    workflowId = newId();
    const idle = agent('Idle', '   ');
    expect(codes([idle])).toEqual([['missing_input', idle.id]]);
  });

  it('still needs an Output node to be connected when there is one', () => {
    workflowId = newId();
    const result = output();
    const issues = codes([agent('Poet', 'Write.'), result]);
    expect(issues).toContainEqual(['unconnected_required_input', result.id]);
  });
});

describe('D285 a run of goal-driven nodes', () => {
  it('runs a lone Agent from its goal to COMPLETE', async () => {
    behaviour = () => ({ text: 'Soft rain on the roof' });
    const poet = agent('Poet', 'Write a haiku about rain.');
    await seed([poet], []);

    const run = await service.startRun(workflowId, {});

    expect(run.status).toBe('COMPLETE');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Write a haiku about rain.');
  });

  it('passes each node’s output down a chain and completes when the last node does', async () => {
    behaviour = (prompt) =>
      prompt.includes('Critique') ? { text: 'Too wet.' } : { text: 'Soft rain on the roof' };
    const writer = agent('Writer', 'Write a haiku about rain.');
    const critic = agent('Critic', 'Critique the haiku you are given.');
    await seed([writer, critic], [edge(writer, critic)]);

    const run = await service.startRun(workflowId, {});

    expect(run.status).toBe('COMPLETE');
    const criticPrompt = prompts.find((p) => p.includes('Critique'));
    expect(criticPrompt).toContain('Soft rain on the roof');
  });

  it('hands each node’s goal and result to its chat session before announcing its final state', async () => {
    behaviour = () => ({ text: 'Soft rain on the roof' });
    const poet = agent('Poet', 'Write a haiku about rain.');
    await seed([poet], []);

    const run = await service.startRun(workflowId, {});

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      nodeId: poet.id,
      runId: run.id,
      goal: [{ type: 'text', text: 'Write a haiku about rain.' }],
      output: [{ type: 'text', text: 'Soft rain on the roof' }],
      modelId: 'scripted-2026',
    });
    expect(turns[0]?.usage?.tokensOut).toBe(3);

    // The COMPLETED frame for the node comes after the turn was handed over.
    const completedAt = events.findIndex(
      (event) =>
        event.type === 'node.state' &&
        (event.payload as { nodeId: string; status: string }).nodeId === poet.id &&
        (event.payload as { status: string }).status === 'COMPLETED',
    );
    expect(completedAt).toBeGreaterThanOrEqual(eventsWhenRecorded[0]!);
  });

  it('hands a failure over as the error, and the run halts', async () => {
    behaviour = () => ({
      throws: new AceNodeError({
        kind: 'invalid_config',
        code: 'model_unavailable',
        message: 'Claude Code cannot use the model "bogus".',
        retryable: false,
      }),
    });
    const poet = agent('Poet', 'Write a haiku about rain.');
    await seed([poet], []);

    const run = await service.startRun(workflowId, {});

    expect(run.status).toBe('HALTED');
    expect(turns).toHaveLength(1);
    expect(turns[0]?.error).toMatchObject({ code: 'model_unavailable' });
    expect(turns[0]?.output).toBeUndefined();
  });

  it('uses what it was handed as the goal when a downstream node has none of its own', async () => {
    behaviour = () => ({ text: 'done' });
    const writer = agent('Writer', 'Write a haiku about rain.');
    const relay = agent('Relay', '');
    await seed([writer, relay], [edge(writer, relay)]);

    await service.startRun(workflowId, {});

    const relayTurn = turns.find((turn) => turn.nodeId === relay.id);
    expect(relayTurn?.goal).toEqual([{ type: 'text', text: 'done' }]);
  });
});
