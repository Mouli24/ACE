import { derivePorts, portId, type Edge, type Node, type NodePortSource } from '@ace/contracts';
import { createAceClient, RunEventBuffer, type AceApiError } from '@ace/sdk';
import { setupServer } from 'msw/node';

import { newId } from '../lib/ulid';
import { MockDb } from './db';
import { createFakeWebSocket } from './fake-socket';
import { createHandlers } from './handlers';
import { createRound2Handlers, preflight, setScenario, stopScenario } from './handlers-round2';

const db = new MockDb({ persist: false });
const server = setupServer(...createRound2Handlers(db), ...createHandlers(db));
const FakeWS = createFakeWebSocket(db);
const client = createAceClient({
  baseUrl: 'http://mock.local',
  token: 'mock',
  fetch: (input, init) => globalThis.fetch(input, init),
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  stopScenario();
  db.reset();
  setScenario('linear-complete');
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function agent(
  workflowId: string,
  config: Partial<{ providerId: string; modelId: string }> = {},
): Node {
  const base: NodePortSource = {
    id: newId(),
    kind: 'agent',
    config: {
      routing: { policy: 'fixed', fallbackModelIds: [] },
      instructions: '',
      inputTypes: ['text'],
      outputTypes: ['text'],
      execution: { temperature: 0.7, maxTokens: 4096, timeoutMs: 120_000, retries: 2 },
      contextPolicy: { budgetTokens: 4000 },
      tools: { enabled: [], maxToolCalls: 10, allowedDomains: [] },
      knowledgeBaseIds: [],
      memory: { enabled: false },
      skillIds: [],
      ...config,
    },
  };
  const node = { ...base, workflowId, name: 'Agent', position: { x: 200, y: 0 } } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}

function input(workflowId: string, text = 'hello'): Node {
  const base: NodePortSource = {
    id: newId(),
    kind: 'input',
    config: { text, artifactIds: [], outputTypes: ['text'] },
  };
  const node = { ...base, workflowId, name: 'Input', position: { x: 0, y: 0 } } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}

function output(workflowId: string): Node {
  const base: NodePortSource = { id: newId(), kind: 'output', config: {} };
  const node = { ...base, workflowId, name: 'Output', position: { x: 400, y: 0 } } as Node;
  return { ...node, ...derivePorts(node) } as Node;
}

const edge = (workflowId: string, from: Node, to: Node, type = 'text'): Edge => ({
  id: newId(),
  workflowId,
  kind: 'data',
  from: { nodeId: from.id, portId: portId(from.id, 'out', type) },
  to: { nodeId: to.id, portId: portId(to.id, 'in', type) },
});

/** A workflow that passes pre-flight: Input → Agent (mock-text) → Output. */
async function runnableWorkflow() {
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'Flow');
  const i = input(workflow.id);
  const a = agent(workflow.id, { providerId: provider.id, modelId: 'mock-text' });
  const o = output(workflow.id);
  db.commitGraph(workflow.id, [i, a, o], [edge(workflow.id, i, a), edge(workflow.id, a, o)], {
    silent: true,
  });
  return { provider, workflow, nodes: { input: i, agent: a, output: o } };
}

describe('providers (§2.5, FR-PRV-001..007)', () => {
  it('creates a provider without storing the key, and reports keySet (FR-PRV-002, BR-07)', async () => {
    const provider = await client.createProvider({
      type: 'anthropic',
      name: 'Anthropic',
      apiKey: 'sk-test-key',
    });
    expect(provider.keySet).toBe(true);
    expect(JSON.stringify(provider)).not.toContain('sk-test-key');
    const listed = await client.listProviders();
    expect(JSON.stringify(listed)).not.toContain('sk-test-key');
  });

  it('a provider without a key reports keySet false', async () => {
    const provider = await client.createProvider({ type: 'mock', name: 'Mock' });
    expect(provider.keySet).toBe(false);
    expect(provider.status).toBe('UNKNOWN');
  });

  it('check produces every §2.6 outcome deterministically and emits provider.status', async () => {
    const cases: Array<[string | undefined, string | undefined, string]> = [
      ['good', undefined, 'CONNECTED'],
      ['bad', undefined, 'AUTH_FAILED'],
      ['ratelimited', undefined, 'RATE_LIMITED'],
      [undefined, 'http://unreachable.local', 'UNREACHABLE'],
    ];
    for (const [apiKey, baseUrl, expected] of cases) {
      const provider = await client.createProvider({
        type: 'openai_compatible',
        name: expected,
        ...(apiKey === undefined ? {} : { apiKey }),
        baseUrl: baseUrl ?? 'http://127.0.0.1:1234',
      });
      const result = await client.checkProvider(provider.id);
      expect(result.status).toBe(expected);
      expect((await client.getProvider(provider.id)).status).toBe(expected);
    }
    expect(db.events.filter((e) => e.type === 'provider.status')).toHaveLength(4);
  });

  it('rotating the key never echoes it back (FR-PRV-002)', async () => {
    const provider = await client.createProvider({ type: 'openai', name: 'OpenAI' });
    expect(provider.keySet).toBe(false);
    const rotated = await client.updateProvider(provider.id, { apiKey: 'sk-rotated' });
    expect(rotated.keySet).toBe(true);
    expect(JSON.stringify(rotated)).not.toContain('sk-rotated');
  });

  it('TC-PRV-006: deleting a provider a node still uses is a 409 naming the nodes', async () => {
    const { provider, nodes } = await runnableWorkflow();
    const failure = (await client
      .deleteProvider(provider.id)
      .catch((e: unknown) => e)) as AceApiError;
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('provider_in_use');
    expect(failure.details).toEqual({ nodeIds: [nodes.agent.id] });
    expect(await client.listProviders()).toMatchObject({ items: [{ id: provider.id }] });

    await client.deleteProvider(provider.id, { confirm: true });
    expect((await client.listProviders()).items).toHaveLength(0);
  });

  it('FR-PRV-007: detect reports Ollama on its default port', async () => {
    expect(await client.detectProviders()).toEqual({
      ollama: { baseUrl: 'http://127.0.0.1:11434', detected: true },
    });
  });
});

describe('models (§2.5, FR-MOD-004/006)', () => {
  it('a new provider brings its catalogue, and refresh returns it with a timestamp', async () => {
    const provider = await client.createProvider({ type: 'mock', name: 'Mock' });
    const listed = await client.listModels({ providerId: provider.id });
    expect(listed.items.length).toBeGreaterThan(5);
    expect(listed.items.every((m) => m.pricing?.priceTableVersion === 'mock-v1')).toBe(true);

    const refreshed = await client.refreshModels(provider.id);
    expect(refreshed.models).toHaveLength(listed.items.length);
    expect(Date.parse(refreshed.refreshedAt)).not.toBeNaN();
  });

  it('TC-MOD-003: filters by provider, data type and availability', async () => {
    const mock = await client.createProvider({ type: 'mock', name: 'Mock' });
    await client.createProvider({ type: 'anthropic', name: 'Anthropic', apiKey: 'k' });

    const jsonOut = await client.listModels({ providerId: mock.id, outputType: 'json' });
    expect(jsonOut.items.map((m) => m.modelId).sort()).toEqual(['mock-bad-json', 'mock-json']);

    const images = await client.listModels({ inputType: 'image' });
    expect(images.items.every((m) => m.inputTypes.includes('image'))).toBe(true);
    expect(images.items.length).toBeGreaterThan(0);

    const available = await client.listModels({ providerId: mock.id, available: true });
    expect(available.items.some((m) => m.modelId === 'mock-retired')).toBe(false);
  });
});

describe('pre-flight (§2.7, FR-EXE-003)', () => {
  it('a node with no model blocks the run and emits nothing', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'Flow');
    db.commitGraph(workflow.id, [input(workflow.id), agent(workflow.id), output(workflow.id)], [], {
      silent: true,
    });

    const run = await client.startRun(workflow.id);
    expect(run.status).toBe('BLOCKED');
    expect(run.preflightIssues.map((i) => i.code)).toContain('missing_model');
    await tick(120);
    expect(db.events.filter((e) => e.type === 'run.started')).toHaveLength(0);
  });

  it('an Input node with nothing to send is missing_input; supplying it at start clears the issue', async () => {
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'Flow');
    const empty = input(workflow.id, '');
    const a = agent(workflow.id, { providerId: provider.id, modelId: 'mock-text' });
    db.commitGraph(workflow.id, [empty, a, output(workflow.id)], [], { silent: true });

    const blocked = await client.startRun(workflow.id);
    expect(blocked.preflightIssues.map((i) => i.code)).toContain('missing_input');

    const started = await client.startRun(workflow.id, {
      inputs: { [empty.id]: [{ type: 'text', text: 'typed at run time' }] },
    });
    expect(started.status).toBe('RUNNING');
  });

  it('the pure check refuses a model whose types do not cover the node (incompatible_model)', () => {
    const workflowId = newId();
    const node = agent(workflowId, { providerId: 'p', modelId: 'mock-json' });
    const issues = preflight(
      [node, output(workflowId)],
      [
        {
          id: newId(),
          providerId: 'p',
          modelId: 'mock-json',
          displayName: 'Mock JSON',
          inputTypes: ['text', 'json'],
          outputTypes: ['json'],
          contextWindow: 8192,
          supportsTools: false,
          supportsJson: true,
          available: true,
          source: 'manifest',
          lastCheckedAt: new Date().toISOString(),
        },
      ],
      {},
      new Set(['p']),
    );
    // the node asks for text out, the model only produces json
    expect(issues.map((i) => i.code)).toContain('incompatible_model');
  });
});

describe('runs and the scripted scenarios (§2.4, §5 item 11)', () => {
  it('linear-complete: the run streams, transfers and completes, and the buffer agrees', async () => {
    const { workflow, nodes } = await runnableWorkflow();
    const socket = createFakeSocketClient(workflow.id);
    const run = await client.startRun(workflow.id);
    expect(run.status).toBe('RUNNING');

    await vi.waitFor(() => expect(socket.buffer.view.status).toBe('COMPLETE'), { timeout: 5000 });
    const view = socket.buffer.view;
    expect(view.nodeState(nodes.agent.id)).toBe('COMPLETED');
    expect(view.streamedText(view.nodeRun(nodes.agent.id)!.nodeRunId).length).toBeGreaterThan(0);
    expect(view.totals.costUsd).toBeGreaterThan(0);
    expect(view.lastTransfer(db.edgesOf(workflow.id)[1]!.id)?.summary).toBeTruthy();
    expect((await client.getRun(run.id)).status).toBe('COMPLETE');
    socket.close();
  });

  it('fallback-used: the first node reports the fallback model (FR-RTR-006)', async () => {
    setScenario('fallback-used');
    const { workflow, nodes } = await runnableWorkflow();
    const socket = createFakeSocketClient(workflow.id);
    await client.startRun(workflow.id);
    await vi.waitFor(() => expect(socket.buffer.view.status).toBe('COMPLETE'), { timeout: 5000 });
    expect(socket.buffer.view.nodeRun(nodes.agent.id)?.modelUsed).toMatchObject({
      viaFallback: true,
    });
    socket.close();
  });

  it('contract-violation: the node fails with CONTRACT_VIOLATION and the run halts (BR-03)', async () => {
    setScenario('contract-violation');
    const { workflow, nodes } = await runnableWorkflow();
    const socket = createFakeSocketClient(workflow.id);
    await client.startRun(workflow.id);
    await vi.waitFor(() => expect(socket.buffer.view.status).toBe('HALTED'), { timeout: 5000 });
    const nodeRun = socket.buffer.view.nodeRun(nodes.agent.id);
    expect(nodeRun?.status).toBe('FAILED');
    expect(nodeRun?.failureReason).toBe('CONTRACT_VIOLATION');
    expect(nodeRun?.error?.kind).toBe('agent');
    socket.close();
  });

  it('all-nine-states: every NodeState of Arch §19.1 arrives (TC-EXE-008)', async () => {
    setScenario('all-nine-states');
    const { workflow, nodes } = await runnableWorkflow();
    const seen: string[] = [];
    const socket = createFakeSocketClient(workflow.id, (frame) => {
      if (frame.type === 'node.state') seen.push((frame.payload as { status: string }).status);
    });
    await client.startRun(workflow.id);
    await vi.waitFor(() => expect(seen).toHaveLength(9), { timeout: 8000 });
    expect(new Set(seen)).toEqual(
      new Set([
        'IDLE',
        'READY',
        'RUNNING',
        'WAITING',
        'PAUSED',
        'COMPLETED',
        'STOPPED',
        'BLOCKED',
        'FAILED',
      ]),
    );
    expect(nodes.agent.id).toBeTruthy();
    socket.close();
  });

  it('events replay after a seq, so a client that missed frames can catch up (FR-EXE-014)', async () => {
    const { workflow } = await runnableWorkflow();
    const run = await client.startRun(workflow.id);
    await tick(400);
    const all = await client.listRunEvents(run.id, { afterSeq: 0 });
    expect(all.length).toBeGreaterThan(3);
    const later = await client.listRunEvents(run.id, { afterSeq: all[1]!.seq });
    expect(later.every((event) => event.seq > all[1]!.seq)).toBe(true);
    // `node.token` is transient and must never appear in the replay (§2.4)
    expect(all.some((event) => event.type === 'node.token')).toBe(false);
  });

  it('a run history lists newest first (FR-EXE-012)', async () => {
    const { workflow } = await runnableWorkflow();
    await client.startRun(workflow.id);
    await tick(30);
    await client.startRun(workflow.id);
    const runs = await client.listRuns(workflow.id);
    expect(runs.items).toHaveLength(2);
    expect(runs.items[0]!.startedAt >= runs.items[1]!.startedAt).toBe(true);
  });
});

/** A socket client wired to the FakeSocket, folding frames through the SDK's buffer. */
function createFakeSocketClient(
  workflowId: string,
  onFrame?: (frame: { type: string; payload: unknown }) => void,
) {
  const buffer = new RunEventBuffer();
  const socket = new FakeWS(`ws://mock.local/ws?token=mock`);
  socket.onmessage = (event) => {
    const frame = JSON.parse(String((event as MessageEvent<string>).data)) as {
      type: string;
      payload: unknown;
    };
    onFrame?.(frame);
    buffer.apply(frame as never);
  };
  socket.onopen = () => {
    socket.send(
      JSON.stringify({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } }),
    );
  };
  return { buffer, close: () => socket.close() };
}
