import {
  AgentConfigSchema,
  API_BASE_PATH,
  type ApiError,
  type ApprovalRequest,
  type Edge,
  type GuardrailPolicy,
  type Model,
  type Node,
  type NodeRun,
  type NodeState,
  type Provider,
  type Run,
  type ToolDefinition,
} from '@ace/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createApprovalService, type ApprovalService } from '../approvals/index.js';
import { createApprovalRoutes } from '../approvals/routes.js';
import { createEventBus } from '../events/index.js';
import { toApiError } from '../gateway/errors.js';
import {
  createGuardrailEvaluator,
  createPolicyService,
  createToolGuardrailEvaluator,
  guardrailStoreFor,
  NO_MASKING,
  type CheckRunner,
} from '../guardrails/index.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type GenerateRequest,
  type ModelRouter,
  type ProviderAdapter,
  type StreamChunk,
} from '../ports/index.js';
import {
  controlStoresFor,
  createRunControls,
  createRunGateRegistry,
  createRunService,
  type ExecutableTool,
  type RunControls,
  type RunService,
} from '../runs/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

/**
 * D-054 — a Stop (or a shutdown) while a node is WAITING on an approval (FR-CTL-003, FR-GRD-013,
 * D110, D111, Arch §19.1).
 *
 * Three ways a node reaches WAITING: an `ask_user` check at the **output** point (round 3), the
 * same at the **input** point on an Input node's content (R3 §4 item 4), and a destructive tool's
 * `destructive_action → ask_user` at the **tool** point, inside the tool loop (round 4 §2.2). All
 * suspend the node on `approvals.request()`. A stop must end the run anyway:
 * HALTED `stopped`, the drive settled, one `run.completed`, the waiting node STOPPED, its approval
 * cancelled, nothing called after it — and an Approve or Reject that arrives afterwards finds
 * nothing to decide (404 `not_found`, D120) and moves nothing.
 *
 * Everything that decides behaviour is the real thing, wired the way `apps/server` wires it: the run
 * service, the controls and their gate registry, the approval service with the server's
 * `onWaiting`/`onDecided` hooks, both guardrail evaluators and the approval routes. Only the store
 * (in memory), the model (scripted), the check runner (two checks) and the tool (a recording
 * `sandbox_delete`) are stand-ins. Every wait is bounded, so a hang fails the test instead of the
 * suite.
 */

const scope = LOCAL_SCOPE;
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const NOW = '2026-09-30T10:00:00.000Z';

/** How long a drive may take to settle once the stop has answered. FR-CTL-003's budget is 2 s. */
const SETTLE_MS = 2_000;

/** Rejects with `label` if `promise` has not settled within `ms` — a hang becomes a failure. */
async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The destructive tool the round-4 fixtures use (§2.2), recording what it would have deleted. */
const deleteDefinition: ToolDefinition = {
  name: 'sandbox_delete',
  description: 'Deletes a file inside the sandbox folder.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: ['<sandbox>'], destructive: true },
  timeoutMs: 5_000,
  source: 'builtin',
};

/** Two checks, shaped like `@ace/guardrails`' — an email at the output, a destructive tool. */
const checks: CheckRunner = {
  evaluate(check, input) {
    if (check.type === 'pii') {
      return input.text.includes('@')
        ? { passed: false, reason: 'Personal data found: email.', redactedTypes: ['email'] }
        : { passed: true, reason: 'No personal data found.' };
    }
    if (check.type === 'destructive_action' && input.tool !== undefined) {
      return input.tool.definition.permissions.destructive
        ? {
            passed: false,
            reason: `Tool ${input.tool.definition.name} performs a destructive action.`,
          }
        : { passed: true, reason: `Tool ${input.tool.definition.name} is not destructive.` };
    }
    return undefined;
  },
};

/** The project default: input and output `pii → ask_user`, tool `destructive_action → ask_user`. */
const askPolicy: GuardrailPolicy = {
  id: newId(),
  projectId: PROJECT_ID,
  name: 'Ask first',
  version: 1,
  isProjectDefault: true,
  checks: [
    { id: newId(), point: 'input', type: 'pii', action: 'ask_user', enabled: true, params: {} },
    { id: newId(), point: 'output', type: 'pii', action: 'ask_user', enabled: true, params: {} },
    {
      id: newId(),
      point: 'tool',
      type: 'destructive_action',
      action: 'ask_user',
      enabled: true,
      params: {},
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};

interface Harness {
  repository: FakeRepository;
  events: EngineEvent[];
  service: RunService;
  controls: RunControls;
  approvals: ApprovalService;
  workflowId: string;
  /** `generate()` calls per node name, and how many of them were made on an aborted signal. */
  calls: (name: string) => number;
  callsAfterAbort: (name: string) => number;
  /** Every path `sandbox_delete` was asked to delete — i.e. actually ran with. */
  deleted: string[];
  /** POST /node-runs/:id/approve or /reject through the real routes. */
  decide: (nodeRunId: string, kind: 'approve' | 'reject') => Promise<Response>;
  seed: (agent: 'Writer' | 'Cleaner', brief?: string) => Promise<{ agent: Node }>;
  framesOf: (nodeId: string) => string[];
  waitForApproval: (runId: string) => Promise<ApprovalRequest>;
  nodeRun: (id: string) => Promise<NodeRun>;
  runRow: (id: string) => Promise<Run>;
}

async function createHarness(): Promise<Harness> {
  const repository = new FakeRepository();
  const bus = createEventBus({ repository, scope, pubsub: new InProcessPubSubStub<EngineEvent>() });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  const workflowId = newId();
  const provider: Provider = {
    id: PROVIDER_ID,
    type: 'mock',
    name: 'Scripted',
    keySet: false,
    status: 'CONNECTED',
    concurrency: 4,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const model: Model = {
    id: newId(),
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    displayName: 'Scripted',
    inputTypes: ['text'],
    outputTypes: ['text'],
    contextWindow: 200_000,
    supportsTools: true,
    supportsJson: false,
    available: true,
    source: 'discovered',
    lastCheckedAt: NOW,
    pricing: { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
  };
  await repository.providers.create(scope, provider);
  await repository.models.replaceForProvider(scope, PROVIDER_ID, [model]);
  await repository.settings.update(scope, { dataDir: '/tmp/ace', concurrency: 20 });
  await repository.guardrailPolicies.create(scope, askPolicy);

  const callCounts = new Map<string, number>();
  const abortedCalls = new Map<string, number>();
  const nameIn = (request: GenerateRequest): string =>
    /Act as (\w+)\./.exec(`${request.system ?? ''}\n${request.prompt}`)?.[1] ?? 'unknown';

  /*
   * Writer answers with an email address, which the output point's `pii → ask_user` holds for a
   * person. Cleaner asks for `sandbox_delete` on its first turn — the tool point's approval — and
   * would confirm on its second, which it must never reach after a stop.
   */
  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(request, signal) {
      const name = nameIn(request);
      callCounts.set(name, (callCounts.get(name) ?? 0) + 1);
      if (signal.aborted) abortedCalls.set(name, (abortedCalls.get(name) ?? 0) + 1);
      const firstTurn = (request.toolResults ?? []).length === 0;

      return (async function* (): AsyncGenerator<StreamChunk> {
        await Promise.resolve();
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (name === 'Cleaner' && firstTurn) {
          yield { type: 'usage', tokensIn: 5, tokensOut: 1 };
          yield {
            type: 'tool_call',
            callId: 'call-1',
            name: 'sandbox_delete',
            args: { path: 'notes.txt' },
          };
          yield { type: 'finish', reason: 'tool_calls' };
          return;
        }
        yield {
          type: 'text',
          delta: name === 'Writer' ? 'Reach me at jane@example.com.' : 'Deleted.',
        };
        yield { type: 'usage', tokensIn: 7, tokensOut: 3 };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };

  const deleted: string[] = [];
  const sandboxDelete: ExecutableTool = {
    definition: deleteDefinition,
    run: async (args) => {
      const path = (args as { path?: unknown }).path;
      deleted.push(typeof path === 'string' ? path : String(path));
      return { deleted: true };
    },
  };

  const router: ModelRouter = {
    resolve: (_node, _requirements, state) =>
      state.failures.length > 0
        ? { ok: false, code: 'no_candidate_left', reason: 'every model was tried' }
        : { ok: true, route: { providerId: PROVIDER_ID, modelId: 'scripted', viaFallback: false } },
    resolveForBench: () => ({ ok: false, code: 'policy_not_allowed', reason: 'not benched' }),
  };

  /* The round-3 services, wired exactly as `apps/server/src/server.ts` wires them. */
  const guardrailStore = guardrailStoreFor(repository, scope);
  const emitNodeState = async (
    runId: string,
    nodeRun: NodeRun | null,
    status: 'WAITING' | 'RUNNING',
  ): Promise<void> => {
    if (nodeRun === null) return;
    const run = await repository.runs.get(scope, runId);
    await bus.emit({
      type: 'node.state',
      ...(run === null ? {} : { workflowId: run.workflowId }),
      runId,
      payload: {
        runId,
        nodeRunId: nodeRun.id,
        nodeId: nodeRun.nodeId,
        iteration: nodeRun.iteration,
        attempt: nodeRun.attempt,
        status,
      },
    });
  };
  const approvals = createApprovalService({
    scope,
    approvals: guardrailStore.approvals,
    nodeRuns: guardrailStore.nodeRuns,
    bus,
    onWaiting: async (request) => {
      const row = await repository.nodeRuns.update(scope, request.nodeRunId, { status: 'WAITING' });
      await emitNodeState(request.runId, row, 'WAITING');
    },
    onDecided: async (request, decision) => {
      if (decision.decision !== 'approve') return;
      const row = await repository.nodeRuns.update(scope, request.nodeRunId, { status: 'RUNNING' });
      await emitNodeState(request.runId, row, 'RUNNING');
    },
  });
  const policies = createPolicyService({
    scope,
    policies: guardrailStore.policies,
    projects: guardrailStore.projects,
    policyUsage: guardrailStore.policyUsage,
    checks,
  });
  const guardrails = createGuardrailEvaluator({
    scope,
    checks,
    masker: NO_MASKING,
    verdicts: guardrailStore.verdicts,
    bus,
    approvals,
  });
  const toolGuardrails = createToolGuardrailEvaluator({
    scope,
    checks,
    verdicts: guardrailStore.verdicts,
    bus,
    approvals,
  });

  const gates = createRunGateRegistry();
  const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
  const service = createRunService({
    gates,
    repository,
    scope,
    bus,
    logger,
    router,
    adapterFor: async () => adapter,
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    runGated: async (_providerId, fn) => fn(),
    policies,
    guardrails,
    approvals,
    tools: { get: (name) => (name === 'sandbox_delete' ? sandboxDelete : undefined) },
    sandboxDirFor: (runId) => `/tmp/ace/sandbox/${runId}`,
    toolGuardrails,
    tokenBatchMs: 0,
  });
  const controls = createRunControls({
    ...controlStoresFor(repository, scope),
    bus,
    gates,
    approvals,
    logger,
    driveRecordedRun: (run) => service.driveRecordedRun(run),
    drivePartialRun: (plan) => service.drivePartialRun(plan),
    envelopesFor: (run, nodeId) => service.envelopesFor(run, nodeId),
  });

  /* The approval routes behind the gateway's error envelope, as in the guardrail route tests. */
  const app = new Hono();
  app.onError((error, c) => {
    const { status, body } = toApiError(error);
    return c.json(body, status as 400);
  });
  const api = new Hono();
  api.route('/', createApprovalRoutes(approvals));
  app.route(API_BASE_PATH, api);

  const port = (nodeId: string, dir: 'in' | 'out') => ({
    id: `${nodeId}:${dir}:text`,
    name: 'text',
    dataType: 'text' as const,
    multi: dir === 'out',
  });
  const edge = (from: Node, to: Node): Edge => ({
    id: newId(),
    workflowId,
    kind: 'data',
    from: { nodeId: from.id, portId: `${from.id}:out:text` },
    to: { nodeId: to.id, portId: `${to.id}:in:text` },
  });

  const framesOf = (nodeId: string): string[] =>
    events
      .filter((event) => event.type === 'node.state')
      .map((event) => event.payload as { nodeId: string; status: NodeState })
      .filter((payload) => payload.nodeId === nodeId)
      .map((payload) => payload.status);

  return {
    repository,
    events,
    service,
    controls,
    approvals,
    workflowId,
    calls: (name) => callCounts.get(name) ?? 0,
    callsAfterAbort: (name) => abortedCalls.get(name) ?? 0,
    deleted,
    decide: async (nodeRunId, kind) =>
      app.request(`http://127.0.0.1:4747${API_BASE_PATH}/node-runs/${nodeRunId}/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ note: 'decided after the stop' }),
        headers: { 'content-type': 'application/json' },
      }),

    async seed(name, text = 'Tidy up the working folder.') {
      const brief: Node = {
        id: newId(),
        workflowId,
        kind: 'input',
        name: 'Brief',
        position: { x: 0, y: 0 },
        inputs: [],
        outputs: [],
        config: { text, artifactIds: [], outputTypes: ['text'] },
      };
      brief.outputs = [port(brief.id, 'out')];
      const agentId = newId();
      const agent: Node = {
        id: agentId,
        workflowId,
        kind: 'agent',
        name,
        position: { x: 0, y: 0 },
        inputs: [port(agentId, 'in')],
        outputs: [port(agentId, 'out')],
        config: AgentConfigSchema.parse({
          providerId: PROVIDER_ID,
          modelId: 'scripted',
          instructions: `Act as ${name}.`,
          inputTypes: ['text'],
          outputTypes: ['text'],
          execution: { retries: 0 },
          ...(name === 'Cleaner'
            ? { tools: { enabled: ['sandbox_delete'], maxToolCalls: 10, allowedDomains: [] } }
            : {}),
        }),
      };
      const resultId = newId();
      const result: Node = {
        id: resultId,
        workflowId,
        kind: 'output',
        name: 'Result',
        position: { x: 0, y: 0 },
        inputs: [port(resultId, 'in')],
        outputs: [],
        config: {},
      };

      await repository.workflows.create(scope, {
        id: workflowId,
        projectId: PROJECT_ID,
        name: 'Flow',
        version: 1,
        formatVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      for (const node of [brief, agent, result]) await repository.nodes.insert(scope, node);
      for (const item of [edge(brief, agent), edge(agent, result)]) {
        await repository.edges.insert(scope, item);
      }
      return { agent };
    },

    framesOf,

    async waitForApproval(runId) {
      const deadline = Date.now() + SETTLE_MS;
      for (;;) {
        const [pending] = await approvals.listPending(runId);
        if (pending !== undefined) {
          const row = await repository.nodeRuns.get(scope, pending.nodeRunId);
          if (row?.status === 'WAITING') return pending;
        }
        if (Date.now() > deadline) throw new Error('no node went WAITING on an approval');
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },

    async nodeRun(id) {
      const row = await repository.nodeRuns.get(scope, id);
      if (row === null) throw new Error(`no node run ${id}`);
      return row;
    },

    async runRow(id) {
      const row = await repository.runs.get(scope, id);
      if (row === null) throw new Error(`no run ${id}`);
      return row;
    },
  };
}

const PATHS = [
  {
    point: 'output',
    agent: 'Writer',
    brief: undefined,
    callsBefore: 1,
    label: 'an output-point ask_user approval (round 3, FR-GRD-013)',
  },
  {
    point: 'tool',
    agent: 'Cleaner',
    brief: undefined,
    callsBefore: 1,
    label: 'a destructive tool approval inside the tool loop (round 4 §2.2, FR-GRD-006)',
  },
  {
    point: 'input',
    agent: 'Writer',
    brief: 'Send the notes to jane@example.com.',
    callsBefore: 0,
    label: "an input-point ask_user approval on the Input node's content (R3 §4 item 4)",
  },
] as const;

describe.each(PATHS)('FR-CTL-003 FR-GRD-013 D-054 Stop while a node is WAITING on $label', (path) => {
  /** Start the run and hold it at the approval, with one `generate()` behind it. */
  async function startWaiting(h: Harness) {
    await h.seed(path.agent, path.brief);
    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const request = await h.waitForApproval(run.id);
    expect(request.point).toBe(path.point);
    expect(h.calls(path.agent)).toBe(path.callsBefore);
    return { run, done, request };
  }

  it('halts the run `stopped`, settles the drive and stops the node without calling anything more', async () => {
    const h = await createHarness();
    const { run, done, request } = await startWaiting(h);

    const stopped = await within(h.controls.stop(run.id), SETTLE_MS, 'POST /runs/:id/stop');
    expect(stopped).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });

    // The drive must settle on its own — nobody is going to answer the approval now.
    const final = await within(done, SETTLE_MS, "the run's drive");
    expect(final).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(h.events.filter((event) => event.type === 'run.completed')).toHaveLength(1);

    // D111: the WAITING node run is STOPPED — a cancellation, never a failure (FR-ERR-007).
    const row = await h.nodeRun(request.nodeRunId);
    expect(row.status).toBe('STOPPED');
    expect(row.failureReason).toBeUndefined();
    expect(h.framesOf(request.nodeId)).toEqual(['READY', 'RUNNING', 'WAITING', 'STOPPED']);

    // Its approval is cancelled (a reject nobody made, with a note), so no card is left on a dead run.
    expect(await h.approvals.listPending(run.id)).toEqual([]);
    const stored = await h.repository.approvals.get(scope, request.id);
    expect(stored?.decision?.decision).toBe('reject');
    expect(
      h.events.filter(
        (event) =>
          event.type === 'node.approval_decided' &&
          (event.payload as { nodeRunId: string }).nodeRunId === request.nodeRunId,
      ),
    ).toHaveLength(1);

    // Nothing ran after the stop: no second turn, no tool, no output, no failure frame.
    expect(h.calls(path.agent)).toBe(path.callsBefore);
    expect(h.callsAfterAbort(path.agent)).toBe(0);
    expect(h.deleted).toEqual([]);
    const outputs = h.events.filter(
      (event) =>
        event.type === 'node.output' &&
        (event.payload as { nodeId: string }).nodeId === request.nodeId,
    );
    expect(outputs).toEqual([]);
    expect(h.events.some((event) => event.type === 'node.error')).toBe(false);

    // A stopped run still spent what it spent (TC-OBS-002): the node run kept its call's usage.
    expect(row.usage.tokensIn > 0).toBe(path.callsBefore > 0);
    expect(final.totals.tokensIn).toBe(row.usage.tokensIn);
  });

  it.each(['approve', 'reject'] as const)(
    'a later %s answers 404 not_found (D120) and leaves the node STOPPED in a HALTED run',
    async (kind) => {
      const h = await createHarness();
      const { run, done, request } = await startWaiting(h);

      await within(h.controls.stop(run.id), SETTLE_MS, 'POST /runs/:id/stop');
      const response = await within(h.decide(request.nodeRunId, kind), SETTLE_MS, `POST ${kind}`);

      expect(response.status).toBe(404);
      expect(((await response.json()) as ApiError).error.code).toBe('not_found');

      await within(done, SETTLE_MS, "the run's drive");
      expect((await h.nodeRun(request.nodeRunId)).status).toBe('STOPPED');
      expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
      expect(h.events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
      expect(h.calls(path.agent)).toBe(path.callsBefore);
      expect(h.deleted).toEqual([]);
    },
  );

  it('an approve that races the stop runs nothing and does not move the stopped node', async () => {
    const h = await createHarness();
    const { run, done, request } = await startWaiting(h);

    // Pressed together: whichever write lands first, the stop wins what the node and run end as.
    const [stop] = await within(
      Promise.allSettled([h.controls.stop(run.id), h.decide(request.nodeRunId, 'approve')]),
      SETTLE_MS,
      'the stop and the approve',
    );
    expect(stop.status).toBe('fulfilled');

    await within(done, SETTLE_MS, "the run's drive");
    // Let a late hook write land, if there is one, before reading the rows.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await h.nodeRun(request.nodeRunId)).status).toBe('STOPPED');
    expect(await h.runRow(run.id)).toMatchObject({ status: 'HALTED', haltReason: 'stopped' });
    expect(await h.approvals.listPending(run.id)).toEqual([]);
    expect(h.calls(path.agent)).toBe(path.callsBefore);
    expect(h.callsAfterAbort(path.agent)).toBe(0);
    expect(h.deleted).toEqual([]);
  });

  it('a shutdown while WAITING halts the run `shutdown` and cancels the approval (FR-SYS-008)', async () => {
    const h = await createHarness();
    const { run, done, request } = await startWaiting(h);

    await within(h.service.shutdown(), SETTLE_MS, 'the run service shutdown');
    const final = await within(done, SETTLE_MS, "the run's drive");

    expect(final).toMatchObject({ status: 'HALTED', haltReason: 'shutdown' });
    expect(h.events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    // No control wrote this row, so the drive ends it and announces it itself.
    expect((await h.nodeRun(request.nodeRunId)).status).toBe('STOPPED');
    expect(h.framesOf(request.nodeId).at(-1)).toBe('STOPPED');
    expect(await h.approvals.listPending(run.id)).toEqual([]);
    expect(h.calls(path.agent)).toBe(path.callsBefore);
    expect(h.deleted).toEqual([]);
  });
});
