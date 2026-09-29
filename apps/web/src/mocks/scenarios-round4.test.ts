import {
  ApprovalRequestSchema,
  RunEventSchema,
  ToolCallSchema,
  derivePorts,
  portId,
  type Artifact,
  type Edge,
  type Node,
  type NodePortSource,
  type NodeRun,
  type Part,
  type Run,
} from '@ace/contracts';
import { setupServer } from 'msw/node';

import { newId } from '../lib/ulid';
import { MockDb } from './db';
import { createFakeWebSocket } from './fake-socket';
import { createHandlers } from './handlers';
import { createRound2Handlers, setScenario, setStreamPace, stopScenario } from './handlers-round2';
import { createRound3Handlers } from './handlers-round3';
import { createRound4Handlers } from './handlers-round4';

/**
 * The round 4 run scenarios (§2.4, §2.6): tools, multimodal outputs and the timeline, driven over
 * HTTP + the fake socket the way the round 3 scenarios are — so the tools UI, output renderers and
 * Timeline tab can be built and tested before A4 lands.
 */

const db = new MockDb({ persist: false });
const server = setupServer(
  ...createRound4Handlers(db),
  ...createRound3Handlers(db),
  ...createRound2Handlers(db),
  ...createHandlers(db),
);
const FakeWS = createFakeWebSocket(db);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  stopScenario();
  db.reset();
  setScenario('linear-complete');
  setStreamPace('normal');
});
afterEach(() => stopScenario());

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = new TextEncoder();

async function call<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const response = await fetch(`http://mock.local/api/v1${path}`, {
    method,
    headers: { authorization: 'Bearer mock', 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

interface Frame {
  type: string;
  payload: Record<string, unknown>;
  seq?: number;
}

function watch(workflowId: string) {
  const frames: Frame[] = [];
  const socket = new FakeWS('ws://mock.local/ws?token=mock');
  socket.onmessage = (event) => {
    const frame = JSON.parse(String((event as MessageEvent<string>).data)) as Frame;
    if (frame.type !== 'hello') frames.push(frame);
  };
  socket.onopen = () =>
    socket.send(
      JSON.stringify({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } }),
    );
  return {
    frames,
    of: (type: string) => frames.filter((f) => f.type === type),
    close: () => socket.close(),
  };
}

/* ---------------------------------------------------------------- graph fixtures */

function withPorts(node: Node): Node {
  return { ...node, ...derivePorts(node) } as Node;
}

function agentNode(workflowId: string, name: string, config: Record<string, unknown>): Node {
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
  return withPorts({ ...base, workflowId, name, position: { x: 200, y: 0 } } as Node);
}

function inputNode(workflowId: string, config: Record<string, unknown> = {}): Node {
  const base: NodePortSource = {
    id: newId(),
    kind: 'input',
    config: { text: 'summarise', artifactIds: [], outputTypes: ['text'], ...config },
  };
  return withPorts({ ...base, workflowId, name: 'Input', position: { x: 0, y: 0 } } as Node);
}

function outputNode(workflowId: string): Node {
  const base: NodePortSource = { id: newId(), kind: 'output', config: {} };
  return withPorts({ ...base, workflowId, name: 'Output', position: { x: 400, y: 0 } } as Node);
}

const dataEdge = (workflowId: string, from: Node, to: Node): Edge => ({
  id: newId(),
  workflowId,
  kind: 'data',
  from: { nodeId: from.id, portId: from.outputs[0]!.id },
  to: { nodeId: to.id, portId: portId(to.id, 'in', 'text') },
});

function seed(agentConfig: Record<string, unknown>, inputConfig: Record<string, unknown> = {}) {
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'Flow');
  const model = { providerId: provider.id, modelId: 'mock-text', ...agentConfig };
  const i = inputNode(workflow.id, inputConfig);
  const a = agentNode(workflow.id, 'Agent', model);
  const o = outputNode(workflow.id);
  db.commitGraph(
    workflow.id,
    [i, a, o],
    [dataEdge(workflow.id, i, a), dataEdge(workflow.id, a, o)],
    { silent: true },
  );
  return { provider, project, workflow, input: i, agent: a, output: o };
}

const runOf = (runId: string) => call<Run>('GET', `/runs/${runId}`);
const nodeRunsOf = (runId: string) => call<NodeRun[]>('GET', `/runs/${runId}/node-runs`);
const startRun = (workflowId: string) => call<Run>('POST', `/workflows/${workflowId}/runs`, {});

/* ---------------------------------------------------------------- the scenarios */

describe('tool-loop (§2.6 mock-tool, FR-TOOL-009, TC-TOOL-010)', () => {
  it('logs echo calls on the node run and over the socket, then answers', async () => {
    setScenario('tool-loop');
    const { workflow, agent } = seed({
      tools: { enabled: ['echo'], maxToolCalls: 3, allowedDomains: [] },
    });
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 5000,
    });
    const toolCallFrames = socket.of('tool.call');
    expect(toolCallFrames.length).toBe(3);
    const logged = ToolCallSchema.parse(toolCallFrames[0]!.payload.toolCall);
    expect(logged.toolName).toBe('echo');
    expect(logged.status).toBe('ok');
    expect(logged.verdicts[0]?.checkType).toBe('tool_allowed');

    const agentRun = (await nodeRunsOf(run.id)).find((each) => each.nodeId === agent.id);
    expect(agentRun?.toolCalls).toHaveLength(3);
    expect(agentRun?.output?.[0]).toMatchObject({ type: 'text' });
    socket.close();
  });
});

describe('destructive-approval (§2.6 mock-destructive, TC-GRD-008, FR-TOOL-009)', () => {
  it('waits with an approval card naming the tool, then completes on approve with the call logged', async () => {
    setScenario('destructive-approval');
    const { workflow, agent } = seed({
      tools: { enabled: ['sandbox_delete'], maxToolCalls: 5, allowedDomains: [] },
    });
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(() => expect(socket.of('node.approval_required')).toHaveLength(1), {
      timeout: 5000,
    });
    const request = ApprovalRequestSchema.parse(
      socket.of('node.approval_required')[0]!.payload.request,
    );
    expect(request.point).toBe('tool');
    expect(request.checkType).toBe('destructive_action');
    expect(request.preview).toContain('sandbox_delete');
    expect(request.preview).toContain('notes.txt');

    // nothing plays while it waits
    const frozen = socket.frames.length;
    await tick(200);
    expect(socket.frames).toHaveLength(frozen);

    await call('POST', `/node-runs/${request.nodeRunId}/approve`, {});
    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 5000,
    });
    const agentRun = (await nodeRunsOf(run.id)).find((each) => each.nodeId === agent.id);
    expect(agentRun?.status).toBe('COMPLETED');
    const deleteCall = agentRun?.toolCalls.find((each) => each.toolName === 'sandbox_delete');
    expect(deleteCall?.status).toBe('ok');
    socket.close();
  });

  it('reject fails the node GUARDRAIL_VIOLATION and halts the run (TC-GRD-008 reject)', async () => {
    setScenario('destructive-approval');
    const { workflow, agent } = seed({
      tools: { enabled: ['sandbox_delete'], maxToolCalls: 5, allowedDomains: [] },
    });
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(() => expect(socket.of('node.approval_required')).toHaveLength(1), {
      timeout: 5000,
    });
    const request = ApprovalRequestSchema.parse(
      socket.of('node.approval_required')[0]!.payload.request,
    );
    await call('POST', `/node-runs/${request.nodeRunId}/reject`, {});

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('HALTED'), {
      timeout: 5000,
    });
    const agentRun = (await nodeRunsOf(run.id)).find((each) => each.nodeId === agent.id);
    expect(agentRun?.status).toBe('FAILED');
    expect(agentRun?.failureReason).toBe('GUARDRAIL_VIOLATION');
    socket.close();
  });
});

describe('vision-flow (§2.6 mock-vision, TC-MM-009/004)', () => {
  it('describes the attached image and carries it as a reference, never bytes', async () => {
    const png = db.putArtifact({
      mime: 'image/png',
      name: 'photo.png',
      bytes: enc.encode('PNGDATA'),
    });
    setScenario('vision-flow');
    const { workflow, agent } = seedVision(png);
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 5000,
    });
    const visionRun = (await nodeRunsOf(run.id)).find((each) => each.nodeId === agent.id);
    const text = (visionRun?.output?.[0] as { text?: string } | undefined)?.text ?? '';
    expect(text).toContain('photo.png');
    expect(text).toContain(String(png.size));

    // the envelope read the image as a reference — no bytes, no base64 anywhere (BR-02, TC-MM-004)
    const envelopeJson = JSON.stringify(visionRun?.inputEnvelopes ?? []);
    expect(envelopeJson).not.toMatch(/bytes|base64/i);
    const imagePart = visionRun?.inputEnvelopes[0]?.reads.find(
      (part: Part) => part.type === 'image',
    );
    expect(imagePart).toMatchObject({ type: 'image', artifactId: png.id });
  });
});

describe('media-outputs (§2.6 mock-media, TC-MM-006/003)', () => {
  it('produces one Part of every type, the binary ones backed by stored artifacts', async () => {
    setScenario('media-outputs');
    const { workflow, agent } = seed({ modelId: 'mock-media', outputTypes: ['text'] });
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 5000,
    });
    const mediaRun = (await nodeRunsOf(run.id)).find((each) => each.nodeId === agent.id);
    const parts = mediaRun?.output ?? [];
    expect(parts.map((part) => part.type).sort()).toEqual(
      ['audio', 'code', 'file', 'image', 'json', 'text', 'video'].sort(),
    );

    for (const part of parts) {
      if (
        part.type === 'image' ||
        part.type === 'audio' ||
        part.type === 'video' ||
        part.type === 'file'
      ) {
        expect(db.getArtifact(part.artifactId)).toBeDefined();
        expect(db.artifactBytes(part.artifactId)).toBeInstanceOf(Uint8Array);
      }
    }
  });
});

describe('timeline-six-types (§2.6, TC-CHAT-001)', () => {
  it('produces one message of every timeline style, stored so GET /messages replays them', async () => {
    setScenario('timeline-six-types');
    const { workflow } = seed({});
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 5000,
    });
    await vi.waitFor(() => expect(socket.of('message.created').length).toBeGreaterThanOrEqual(6));

    const stored = await call<{ items: { type: string }[] }>(
      'GET',
      `/workflows/${workflow.id}/messages`,
    );
    const types = new Set(stored.items.map((m) => m.type));
    for (const expected of ['user', 'agent', 'output', 'event', 'error', 'system']) {
      expect([...types]).toContain(expected);
    }
    socket.close();
  });
});

describe('every round 4 run frame is one the contract knows (§2.5)', () => {
  it('parses each scenario’s frames against RunEventSchema', async () => {
    for (const scenario of ['tool-loop', 'media-outputs', 'timeline-six-types'] as const) {
      db.reset();
      setScenario(scenario);
      const { workflow } =
        scenario === 'media-outputs' ? seed({ modelId: 'mock-media' }) : seed({});
      const socket = watch(workflow.id);
      await startRun(workflow.id);
      await tick(600);
      const runFrames = socket.frames.filter((frame) => frame.type !== 'mcp.status');
      expect(runFrames.length).toBeGreaterThan(3);
      for (const frame of runFrames) {
        const parsed = RunEventSchema.safeParse(frame);
        expect(
          parsed.success,
          `${scenario}: ${frame.type} ${JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true);
      }
      socket.close();
      stopScenario();
    }
  });
});

/* ---------------------------------------------------------------- vision seed */

function seedVision(png: Artifact) {
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });
  const project = db.createProject({ name: 'Vision' });
  const workflow = db.createWorkflow(project.id, 'Flow');
  const i = inputNode(workflow.id, { text: 'describe this', artifactIds: [png.id] });
  const a = agentNode(workflow.id, 'Vision', {
    providerId: provider.id,
    modelId: 'mock-vision',
    inputTypes: ['text', 'image'],
    outputTypes: ['text'],
  });
  const o = outputNode(workflow.id);
  db.commitGraph(
    workflow.id,
    [i, a, o],
    [dataEdge(workflow.id, i, a), dataEdge(workflow.id, a, o)],
    { silent: true },
  );
  return { provider, project, workflow, input: i, agent: a, output: o };
}
