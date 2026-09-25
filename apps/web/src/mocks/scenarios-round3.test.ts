import {
  APPROVAL_PREVIEW_MAX,
  ApprovalRequestSchema,
  RunEventSchema,
  VerdictSchema,
  allowedRunActions,
  derivePorts,
  portId,
  type BudgetHalt,
  type Edge,
  type LoopConfig,
  type Node,
  type NodePortSource,
  type NodeRun,
  type Run,
  type Verdict,
} from '@ace/contracts';
import { setupServer } from 'msw/node';

import { newId } from '../lib/ulid';
import { MockDb } from './db';
import { createFakeWebSocket } from './fake-socket';
import { createHandlers } from './handlers';
import { createRound2Handlers, setScenario, stopScenario } from './handlers-round2';
import { createRound3Handlers } from './handlers-round3';
import { isPlaybackPaused, pendingPlaybackSteps } from './playback';

/**
 * The round 3 scenarios (§2.6): each one drives the mock engine over HTTP and watches both halves —
 * the frames on the socket and the records `GET /runs/:id/node-runs` answers — because the control
 * and safety UI reads both and they must say the same thing.
 */

const db = new MockDb({ persist: false });
const server = setupServer(
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
});
afterEach(() => stopScenario());

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------- REST + socket */

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

/** A socket client that keeps every frame, so a scenario can be read back in order. */
function watch(workflowId: string) {
  const frames: Frame[] = [];
  const socket = new FakeWS('ws://mock.local/ws?token=mock');
  socket.onmessage = (event) => {
    const frame = JSON.parse(String((event as MessageEvent<string>).data)) as Frame;
    if (frame.type !== 'hello') frames.push(frame);
  };
  socket.onopen = () => {
    socket.send(
      JSON.stringify({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } }),
    );
  };
  return {
    frames,
    of: (type: string) => frames.filter((frame) => frame.type === type),
    close: () => socket.close(),
  };
}

/* ---------------------------------------------------------------- graph fixtures */

function withPorts(node: Node): Node {
  return { ...node, ...derivePorts(node) } as Node;
}

function agent(workflowId: string, name: string, x: number, model: Record<string, unknown>): Node {
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
      ...model,
    },
  };
  return withPorts({ ...base, workflowId, name, position: { x, y: 0 } } as Node);
}

function input(workflowId: string): Node {
  const base: NodePortSource = {
    id: newId(),
    kind: 'input',
    config: { text: 'summarise the report', artifactIds: [], outputTypes: ['text'] },
  };
  return withPorts({ ...base, workflowId, name: 'Input', position: { x: 0, y: 0 } } as Node);
}

function output(workflowId: string): Node {
  const base: NodePortSource = { id: newId(), kind: 'output', config: {} };
  return withPorts({ ...base, workflowId, name: 'Output', position: { x: 900, y: 0 } } as Node);
}

function merge(workflowId: string): Node {
  const base: NodePortSource = { id: newId(), kind: 'merge', config: { mode: 'any' } };
  return withPorts({ ...base, workflowId, name: 'Merge', position: { x: 600, y: 0 } } as Node);
}

const dataEdge = (workflowId: string, from: Node, to: Node, toPort = 'text'): Edge => ({
  id: newId(),
  workflowId,
  kind: 'data',
  from: { nodeId: from.id, portId: from.outputs[0]!.id },
  to: { nodeId: to.id, portId: portId(to.id, 'in', toPort) },
});

const LOOP: LoopConfig = {
  maxIterations: 3,
  exitCondition: { path: 'verdict', equals: 'approved' },
  onMax: 'continue',
};

function seed(
  build: (
    workflowId: string,
    model: Record<string, unknown>,
  ) => {
    nodes: Node[];
    edges: Edge[];
  },
) {
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'Flow');
  const { nodes, edges } = build(workflow.id, {
    providerId: provider.id,
    modelId: 'mock-text',
  });
  db.commitGraph(workflow.id, nodes, edges, { silent: true });
  return { project, workflow, nodes, edges };
}

/** Input → Writer → Editor → Output. */
function chain() {
  const built = seed((workflowId, model) => {
    const i = input(workflowId);
    const a = agent(workflowId, 'Writer', 200, model);
    const b = agent(workflowId, 'Editor', 500, model);
    const o = output(workflowId);
    return {
      nodes: [i, a, b, o],
      edges: [dataEdge(workflowId, i, a), dataEdge(workflowId, a, b), dataEdge(workflowId, b, o)],
    };
  });
  const [i, a, b, o] = built.nodes as [Node, Node, Node, Node];
  return { ...built, input: i, writer: a, editor: b, output: o };
}

/** Input → (Alpha, Beta) → Merge(any) → Output. */
function mergeGraph() {
  const built = seed((workflowId, model) => {
    const i = input(workflowId);
    const alpha = agent(workflowId, 'Alpha', 200, model);
    const beta = agent(workflowId, 'Beta', 300, model);
    const m = merge(workflowId);
    const o = output(workflowId);
    return {
      nodes: [i, alpha, beta, m, o],
      edges: [
        dataEdge(workflowId, i, alpha),
        dataEdge(workflowId, i, beta),
        dataEdge(workflowId, alpha, m, 'in'),
        dataEdge(workflowId, beta, m, 'in'),
        dataEdge(workflowId, m, o, 'json'),
      ],
    };
  });
  const [i, alpha, beta, m, o] = built.nodes as [Node, Node, Node, Node, Node];
  return { ...built, input: i, alpha, beta, merge: m, output: o };
}

/** Input → Writer → Reviewer → Output, with a loop edge from the Reviewer back to the Writer. */
function loopGraph() {
  const built = seed((workflowId, model) => {
    const i = input(workflowId);
    const writer = agent(workflowId, 'Writer', 200, model);
    // the Reviewer answers json, which is what the loop's exit condition reads (§2.4, D73)
    const reviewer = agent(workflowId, 'Reviewer', 500, {
      ...model,
      modelId: 'mock-json',
      outputTypes: ['json'],
    });
    const o = output(workflowId);
    const edges = [
      dataEdge(workflowId, i, writer),
      dataEdge(workflowId, writer, reviewer),
      dataEdge(workflowId, reviewer, o, 'json'),
      {
        id: newId(),
        workflowId,
        kind: 'loop' as const,
        from: { nodeId: reviewer.id, portId: portId(reviewer.id, 'out', 'json') },
        to: { nodeId: writer.id, portId: portId(writer.id, 'in', 'text') },
        loop: LOOP,
      },
    ];
    return { nodes: [i, writer, reviewer, o], edges };
  });
  const [i, writer, reviewer, o] = built.nodes as [Node, Node, Node, Node];
  return { ...built, input: i, writer, reviewer, output: o };
}

const runOf = (runId: string) => call<Run>('GET', `/runs/${runId}`);
const nodeRunsOf = (runId: string) => call<NodeRun[]>('GET', `/runs/${runId}/node-runs`);
const startRun = (workflowId: string) => call<Run>('POST', `/workflows/${workflowId}/runs`, {});

/* ---------------------------------------------------------------- the scenarios */

describe('paused (§2.6, FR-CTL-001/002)', () => {
  it('the run pauses with the actions PAUSED allows, and a resume finishes it', async () => {
    setScenario('paused');
    const { workflow, editor } = chain();
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(() => expect(socket.of('run.paused')).toHaveLength(1), { timeout: 5000 });
    const paused = await runOf(run.id);
    expect(paused.status).toBe('PAUSED');
    expect(paused.pausedAt).toBeTruthy();
    expect(paused.allowedActions).toEqual(allowedRunActions('PAUSED'));
    // the node the pause caught never started
    const waiting = (await nodeRunsOf(run.id)).find((each) => each.nodeId === editor.id);
    expect(waiting?.status).toBe('PAUSED');
    const frames = socket.frames.length;
    await tick(300);
    expect(socket.frames).toHaveLength(frames);
    // the rest of the script is held, not thrown away
    expect(isPlaybackPaused(run.id)).toBe(true);
    expect(pendingPlaybackSteps(run.id)).toBeGreaterThan(0);

    await call('POST', `/runs/${run.id}/resume`);
    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 5000,
    });
    expect((await nodeRunsOf(run.id)).find((each) => each.nodeId === editor.id)?.status).toBe(
      'COMPLETED',
    );
    expect(socket.of('run.resumed')).toHaveLength(1);
    socket.close();
  });
});

describe('stopped (§2.6, FR-CTL-003, FR-ERR-007)', () => {
  it('TC-ERR-008: the in-flight node goes STOPPED and the run halts `stopped`', async () => {
    setScenario('stopped');
    const { workflow, writer } = chain();
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('HALTED'), {
      timeout: 5000,
    });
    const halted = await runOf(run.id);
    expect(halted.haltReason).toBe('stopped');
    expect(halted.allowedActions).toEqual(allowedRunActions('HALTED'));

    const stopped = (await nodeRunsOf(run.id)).find((each) => each.nodeId === writer.id);
    expect(stopped?.status).toBe('STOPPED');
    // STOPPED is not FAILED: no failure reason, no error anywhere on the record (BR-03)
    expect(stopped?.failureReason).toBeUndefined();
    expect(stopped?.error).toBeUndefined();
    expect(socket.of('node.error')).toHaveLength(0);
    const states = socket.of('node.state').map((frame) => frame.payload.status);
    expect(states).toContain('STOPPED');
    expect(states).not.toContain('FAILED');
    socket.close();
  });
});

describe('waiting-approval (§2.6, FR-GRD-013/014/015)', () => {
  it('TC-GRD-008: the node waits with an approval card and nothing plays until a decision', async () => {
    setScenario('waiting-approval');
    const { workflow, writer } = chain();
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(() => expect(socket.of('node.approval_required')).toHaveLength(1), {
      timeout: 5000,
    });
    const request = ApprovalRequestSchema.parse(
      socket.of('node.approval_required')[0]!.payload.request,
    );
    expect(request.preview.length).toBeLessThanOrEqual(APPROVAL_PREVIEW_MAX);
    expect(request.nodeId).toBe(writer.id);
    expect(await call<unknown[]>('GET', `/runs/${run.id}/approvals`)).toHaveLength(1);
    expect((await nodeRunsOf(run.id)).find((each) => each.id === request.nodeRunId)?.status).toBe(
      'WAITING',
    );

    // held: no frame arrives until the decision does (FR-GRD-013)
    const frames = socket.frames.length;
    await tick(300);
    expect(socket.frames).toHaveLength(frames);

    await call('POST', `/node-runs/${request.nodeRunId}/approve`, {});
    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 5000,
    });
    expect(socket.of('node.approval_decided')).toHaveLength(1);
    socket.close();
  });

  it('TC-GRD-018/019: a redact verdict names the type and there is no field for the value', async () => {
    setScenario('waiting-approval');
    const { workflow } = chain();
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(() => expect(socket.of('node.approval_required')).toHaveLength(1), {
      timeout: 5000,
    });
    const verdicts = socket
      .of('guardrail.verdict')
      .map((frame) => VerdictSchema.parse(frame.payload.verdict));
    const redacted = verdicts.find((verdict) => verdict.action === 'redact')!;
    expect(redacted.redactedTypes).toEqual(['api_key']);
    expect(redacted.checkType).toBe('secret_leak');
    // the contract is strict, so a `value` alongside the type is a parse error, not an extra field
    expect(
      VerdictSchema.safeParse({ ...redacted, value: ['sk', 'test', 'x'].join('-') }).success,
    ).toBe(false);
    expect(verdicts.some((verdict) => verdict.action === 'ask_user')).toBe(true);
    // every verdict is on the node run as well as on the socket (FR-GRD-015)
    const request = ApprovalRequestSchema.parse(
      socket.of('node.approval_required')[0]!.payload.request,
    );
    const stored = (await nodeRunsOf(run.id)).find((each) => each.id === request.nodeRunId);
    expect(stored?.verdicts.map((verdict: Verdict) => verdict.checkType)).toEqual([
      'secret_leak',
      'pii',
    ]);
    socket.close();
  });
});

describe('budget-halt (§2.6, FR-GRD-008, D80)', () => {
  it('TC-GRD-012: the totals climb, then the run halts `budget_exceeded` saying which cap', async () => {
    setScenario('budget-halt');
    const { workflow, project } = chain();
    await call('PATCH', `/projects/${project.id}`, { maxCostPerRunUsd: 0.01 });
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('HALTED'), {
      timeout: 5000,
    });
    const halted = await runOf(run.id);
    expect(halted.haltReason).toBe('budget_exceeded');
    const budgetHalt = halted.budgetHalt as BudgetHalt;
    expect(budgetHalt).toMatchObject({ scope: 'run', capUsd: 0.01, projected: true });
    expect(budgetHalt.costUsd).toBeGreaterThan(budgetHalt.capUsd);
    // it stopped before the next dispatch, so it had spent less than the cap (D80)
    expect(halted.totals.costUsd).toBeLessThan(budgetHalt.capUsd);

    const climbing = socket
      .of('usage.updated')
      .map((frame) => (frame.payload.totals as { costUsd: number }).costUsd);
    expect(climbing.length).toBeGreaterThanOrEqual(3);
    expect([...climbing].sort((a, b) => a - b)).toEqual(climbing);
    const verdict = socket
      .of('guardrail.verdict')
      .map((frame) => VerdictSchema.parse(frame.payload.verdict))
      .find((each) => each.point === 'cost');
    expect(verdict).toMatchObject({
      checkType: 'max_cost_per_run',
      action: 'block',
      passed: false,
    });
    socket.close();
  });
});

describe('loop-3-iterations (§2.6, FR-PAR-003..005)', () => {
  it('TC-PAR-006: three iterations, each with its own node runs and output, then a stop reason', async () => {
    setScenario('loop-3-iterations');
    const { workflow, writer, reviewer, edges } = loopGraph();
    const loopEdge = edges.find((each) => each.kind === 'loop')!;
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 8000,
    });
    const iterations = socket.of('loop.iteration');
    expect(iterations).toHaveLength(3);
    expect(iterations.map((frame) => frame.payload.iteration)).toEqual([2, 3, 3]);
    expect(iterations.slice(0, 2).every((frame) => frame.payload.stop === undefined)).toBe(true);
    expect(iterations[2]!.payload.stop).toBe('max_iterations');
    expect(iterations[0]!.payload).toMatchObject({
      edgeId: loopEdge.id,
      targetNodeId: writer.id,
    });

    const records = await nodeRunsOf(run.id);
    const writerRuns = records.filter((each) => each.nodeId === writer.id);
    expect(writerRuns.map((each) => each.iteration)).toEqual([1, 2, 3]);
    // each iteration produced something of its own, which is what the iteration selector shows
    expect(new Set(writerRuns.map((each) => JSON.stringify(each.output))).size).toBe(3);
    const reviewerRuns = records.filter((each) => each.nodeId === reviewer.id);
    expect(reviewerRuns.at(-1)?.loopStop).toBe('max_iterations');
    expect(reviewerRuns.filter((each) => each.loopStop !== undefined)).toHaveLength(1);
    socket.close();
  });
});

describe('merge-any (§2.6, FR-PAR-002)', () => {
  it('the merge completes on the first arrival and the later one is recorded, not fed', async () => {
    setScenario('merge-any');
    const { workflow, alpha, beta, merge: mergeNode, edges } = mergeGraph();
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 8000,
    });
    const records = await nodeRunsOf(run.id);
    const mergeRun = records.find((each) => each.nodeId === mergeNode.id);
    expect(mergeRun?.status).toBe('COMPLETED');
    const merged = mergeRun?.output?.[0];
    expect(merged?.type).toBe('json');
    const inputs = (merged as { value: { inputs: { nodeId: string; port: string }[] } }).value
      .inputs;
    // `any`: one arrival feeds the merge, and it names the port it came in on (D78)
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.nodeId).toBe(alpha.id);
    expect(inputs[0]!.port).toBe(portId(mergeNode.id, 'in', 'in'));

    // the later branch still finished and is still recorded
    expect(records.find((each) => each.nodeId === beta.id)?.status).toBe('COMPLETED');
    const betaEdge = edges.find(
      (each) => each.from.nodeId === beta.id && each.to.nodeId === mergeNode.id,
    )!;
    expect(socket.of('edge.transfer').some((frame) => frame.payload.edgeId === betaEdge.id)).toBe(
      false,
    );
    socket.close();
  });
});

describe('retry-429 (§2.6, FR-ERR-005)', () => {
  it('two attempts fail with a provider 429 and the third completes', async () => {
    setScenario('retry-429');
    const { workflow, writer } = chain();
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('COMPLETE'), {
      timeout: 8000,
    });
    const attempts = (await nodeRunsOf(run.id)).filter((each) => each.nodeId === writer.id);
    expect(attempts.map((each) => each.attempt)).toEqual([1, 2, 3]);
    expect(attempts.map((each) => each.status)).toEqual(['FAILED', 'FAILED', 'COMPLETED']);
    for (const failed of attempts.slice(0, 2)) {
      expect(failed.error).toMatchObject({
        kind: 'provider',
        code: 'rate_limited',
        retryable: true,
      });
      expect(failed.failureReason).toBe('RUN_FAILED');
    }
    expect(socket.of('node.error')).toHaveLength(2);
    socket.close();
  });
});

describe('blocked-downstream (§2.6, FR-ERR-006)', () => {
  it('TC-ERR-007: everything after the failure is BLOCKED, never FAILED', async () => {
    setScenario('blocked-downstream');
    const { workflow, writer, editor } = chain();
    const socket = watch(workflow.id);
    const run = await startRun(workflow.id);

    await vi.waitFor(async () => expect((await runOf(run.id)).status).toBe('HALTED'), {
      timeout: 5000,
    });
    const records = await nodeRunsOf(run.id);
    const failed = records.find((each) => each.nodeId === writer.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.error?.kind).toBe('auth');
    expect(failed?.failureReason).toBe('RUN_FAILED');

    const blocked = records.find((each) => each.nodeId === editor.id);
    expect(blocked?.status).toBe('BLOCKED');
    expect(blocked?.error?.kind).toBe('workflow');
    expect(blocked?.error?.message).toContain(writer.name);
    // exactly one node failed; the rest are blocked (BR-03)
    expect(records.filter((each) => each.status === 'FAILED')).toHaveLength(1);
    expect((await runOf(run.id)).haltReason).toBe('failure');
    socket.close();
  });
});

describe('every round 3 frame is one the contract knows (§2.6)', () => {
  it('parses each scenario’s frames against RunEventSchema', async () => {
    for (const scenario of ['paused', 'stopped', 'waiting-approval', 'budget-halt'] as const) {
      db.reset();
      setScenario(scenario);
      const { workflow } = chain();
      const socket = watch(workflow.id);
      await startRun(workflow.id);
      await tick(600);
      expect(socket.frames.length).toBeGreaterThan(3);
      for (const frame of socket.frames) {
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
