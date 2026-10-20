import type { RunApprovalRequest } from '../ports/index.js';
import {
  AgentConfigSchema,
  API_BASE_PATH,
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

import { createApprovalService, type ApprovalService } from '../approvals/index.js';
import { createGraphService, type GraphService } from '../graph/index.js';
import { createApprovalRoutes } from '../approvals/routes.js';
import { createEventBus, workflowUpdatedEvent } from '../events/index.js';
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
import { createSemaphore } from '../providers/semaphore.js';
import {
  controlStoresFor,
  createAlwaysAllow,
  createRunControls,
  createRunGateRegistry,
  createRunService,
  type CommandClassifier,
  type ExecutableTool,
  type RunControls,
  type RunService,
} from '../runs/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

/**
 * A run service whose nodes can go WAITING on an approval, wired the way `apps/server` wires it
 * (FR-GRD-013, FR-GRD-006, FR-CTL-001..003, FR-PRV-009).
 *
 * Everything that decides behaviour is the real thing: the run service, the controls and their gate
 * registry, the approval service with the server's `onWaiting`/`onDecided` hooks, both guardrail
 * evaluators, the approval routes and a real per-provider semaphore. Only the store (in memory), the
 * model (scripted by node name), the check runner (two checks) and the tool (a recording
 * `sandbox_delete`) are stand-ins.
 *
 * The scripted model, by the name in "Act as <name>.":
 * - **Writer** answers with an email address, which the output point's `pii → ask_user` holds.
 * - **Cleaner** asks for `sandbox_delete { path: 'notes.txt' }` on its first turn — the tool point's
 *   approval — and answers "Deleted." once it has the tool's result.
 * - **Builder** (D376) is an agentic node (`edit_commands`) that asks for `run_command { command:
 *   'npm run build' }` on its first two turns and answers "Built." after the second result.
 *   **Prober** is the same with `echo $(whoami)`, once. Commands are classified by
 *   `options.classify` — the engine cannot import `@ace/tools`' real one (CLAUDE.md §3.4 rule 3).
 * - anyone else answers "Done.".
 * A name in `holds` keeps its first call's stream open until that promise settles or the call's
 * signal aborts, so a test can make a node hold its provider slot.
 */

export const scope = LOCAL_SCOPE;
export const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const NOW = '2026-09-30T10:00:00.000Z';

/** How long a drive may take to settle once a stop has answered. FR-CTL-003's budget is 2 s. */
export const SETTLE_MS = 2_000;

/** Rejects with `label` if `promise` has not settled within `ms` — a hang becomes a failure. */
export async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

/** Two checks, shaped like `@ace/guardrails`' — an email in the text, a destructive tool. */
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
const askPolicy = (): GuardrailPolicy => ({
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
});

export interface ApprovalRunHarness {
  repository: FakeRepository;
  events: EngineEvent[];
  service: RunService;
  controls: RunControls;
  approvals: ApprovalService;
  workflowId: string;
  /** `generate()` calls per node name, and how many of them were made on an aborted signal. */
  calls: (name: string) => number;
  callsAfterAbort: (name: string) => number;
  /** The most `generate()` streams that were ever open at once — what FR-PRV-009 limits. */
  maxConcurrentCalls: () => number;
  /** Node name → a promise its first call's stream is held open on. */
  holds: Map<string, Promise<void>>;
  /** Every path `sandbox_delete` was asked to delete — i.e. actually ran with. */
  deleted: string[];
  /** D376: every command `run_command` actually ran. */
  ran: string[];
  /** D376: the graph service the server's Always allow saves through. */
  graph: GraphService;
  /** POST /node-runs/:id/approve or /reject through the real routes. */
  decide: (
    nodeRunId: string,
    kind: 'approve' | 'reject',
    body?: { note?: string; always?: boolean },
  ) => Promise<Response>;
  /**
   * Brief → each named agent → its own Result. The agents are returned in the order given, which is
   * also their dispatch order (ids are monotonic and the snapshot is sorted by id). `timeoutMs` is
   * every agent's `execution.timeoutMs`.
   */
  seed: (agents: readonly string[], brief?: string, timeoutMs?: number) => Promise<Node[]>;
  /** The `node.state` statuses of one node, in the order they were emitted. */
  framesOf: (nodeId: string) => string[];
  waitFor: (predicate: () => boolean | Promise<boolean>, label: string) => Promise<void>;
  /** The first approval of the run, once its node run is WAITING. */
  waitForApproval: (runId: string) => Promise<RunApprovalRequest>;
  nodeRun: (id: string) => Promise<NodeRun>;
  nodeRunsOf: (runId: string, nodeId: string) => Promise<NodeRun[]>;
  runRow: (id: string) => Promise<Run>;
}

export async function createApprovalRunHarness(
  options: { providerConcurrency?: number; classify?: CommandClassifier } = {},
): Promise<ApprovalRunHarness> {
  const concurrency = options.providerConcurrency ?? 4;
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
    concurrency,
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
  await repository.guardrailPolicies.create(scope, askPolicy());

  const callCounts = new Map<string, number>();
  const abortedCalls = new Map<string, number>();
  const holds = new Map<string, Promise<void>>();
  let open = 0;
  let maxOpen = 0;
  const nameIn = (request: GenerateRequest): string =>
    /Act as (\w+)\./.exec(`${request.system ?? ''}\n${request.prompt}`)?.[1] ?? 'unknown';

  /** Settles with the hold, or rejects with an AbortError the moment the call is aborted. */
  const holdOrAbort = (hold: Promise<void>, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      void hold.then(resolve);
    });

  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate(request, signal) {
      const name = nameIn(request);
      const call = (callCounts.get(name) ?? 0) + 1;
      callCounts.set(name, call);
      if (signal.aborted) abortedCalls.set(name, (abortedCalls.get(name) ?? 0) + 1);
      const firstTurn = (request.toolResults ?? []).length === 0;
      const results = (request.toolResults ?? []).length;
      const commandFor: Record<string, { command: string; times: number }> = {
        Builder: { command: 'npm run build', times: 2 },
        Prober: { command: 'echo $(whoami)', times: 1 },
      };
      const asks = commandFor[name];
      const hold = call === 1 ? holds.get(name) : undefined;

      return (async function* (): AsyncGenerator<StreamChunk> {
        open += 1;
        maxOpen = Math.max(maxOpen, open);
        try {
          if (hold !== undefined) await holdOrAbort(hold, signal);
          else await Promise.resolve();
          if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          if (asks !== undefined && results < asks.times) {
            yield { type: 'usage', tokensIn: 5, tokensOut: 1 };
            yield {
              type: 'tool_call',
              callId: `call-${results + 1}`,
              name: 'run_command',
              args: { command: asks.command },
            };
            yield { type: 'finish', reason: 'tool_calls' };
            return;
          }
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
          const text =
            name === 'Writer'
              ? 'Reach me at jane@example.com.'
              : name === 'Cleaner'
                ? 'Deleted.'
                : name === 'Builder'
                  ? 'Built.'
                  : 'Done.';
          yield { type: 'text', delta: text };
          yield { type: 'usage', tokensIn: 7, tokensOut: 3 };
          yield { type: 'finish', reason: 'stop' };
        } finally {
          open -= 1;
        }
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

  /** D376: a recording `run_command`, destructive like the real one. */
  const ran: string[] = [];
  const runCommand: ExecutableTool = {
    definition: {
      name: 'run_command',
      description: 'Runs a shell command in the project folder.',
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      outputSchema: { type: 'object' },
      permissions: { network: true, fsPaths: ['<project>'], destructive: true },
      timeoutMs: 5_000,
      source: 'builtin',
    },
    run: async (args) => {
      const command = (args as { command?: unknown }).command;
      ran.push(typeof command === 'string' ? command : String(command));
      return { exitCode: 0, stdout: 'ok' };
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
  const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
  const graph = createGraphService({
    repository,
    scope,
    logger,
    onWorkflowUpdated: async (id, version) => {
      await bus.emit(workflowUpdatedEvent(id, version));
    },
  });
  /* D376: the server's `onAlways` — the live run's allowlist, then the saved workflow's node. */
  const alwaysAllow = createAlwaysAllow({
    allowlistFor: (runId) => service.allowlistFor(runId),
    workflowOf: async (runId) => (await repository.runs.get(scope, runId))?.workflowId,
    graph,
    logger,
  });
  const approvals = createApprovalService({
    scope,
    approvals: guardrailStore.approvals,
    nodeRuns: guardrailStore.nodeRuns,
    bus,
    onAlways: (runId, nodeId, prefix) => alwaysAllow(runId, nodeId, prefix),
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

  const semaphore = createSemaphore(concurrency);
  const gates = createRunGateRegistry();
  const service = createRunService({
    gates,
    repository,
    scope,
    bus,
    logger,
    router,
    adapterFor: async () => adapter,
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    runGated: (_providerId, fn) => semaphore.run(fn),
    policies,
    guardrails,
    approvals,
    tools: {
      get: (name) =>
        name === 'sandbox_delete' ? sandboxDelete : name === 'run_command' ? runCommand : undefined,
    },
    ...(options.classify === undefined ? {} : { classifyCommand: options.classify }),
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
  const agentNode = (name: string, timeoutMs?: number): Node => {
    const id = newId();
    return {
      id,
      workflowId,
      kind: 'agent',
      name,
      position: { x: 0, y: 0 },
      inputs: [port(id, 'in')],
      outputs: [port(id, 'out')],
      config: AgentConfigSchema.parse({
        providerId: PROVIDER_ID,
        modelId: 'scripted',
        instructions: `Act as ${name}.`,
        inputTypes: ['text'],
        outputTypes: ['text'],
        execution: { retries: 0, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
        ...(name === 'Cleaner'
          ? { tools: { enabled: ['sandbox_delete'], maxToolCalls: 10, allowedDomains: [] } }
          : {}),
        ...(name === 'Builder' || name === 'Prober'
          ? {
              tools: { enabled: ['run_command'], maxToolCalls: 10, allowedDomains: [] },
              workspace: { access: 'edit_commands', maxTurns: 50, allowedCommands: [] },
            }
          : {}),
      }),
    };
  };
  const outputNode = (): Node => {
    const id = newId();
    return {
      id,
      workflowId,
      kind: 'output',
      name: 'Result',
      position: { x: 0, y: 0 },
      inputs: [port(id, 'in')],
      outputs: [],
      config: {},
    };
  };

  const framesOf = (nodeId: string): string[] =>
    events
      .filter((event) => event.type === 'node.state')
      .map((event) => event.payload as { nodeId: string; status: NodeState })
      .filter((payload) => payload.nodeId === nodeId)
      .map((payload) => payload.status);

  const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    label: string,
  ): Promise<void> => {
    const deadline = Date.now() + SETTLE_MS;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  return {
    repository,
    events,
    service,
    controls,
    approvals,
    workflowId,
    calls: (name) => callCounts.get(name) ?? 0,
    callsAfterAbort: (name) => abortedCalls.get(name) ?? 0,
    maxConcurrentCalls: () => maxOpen,
    holds,
    deleted,
    ran,
    graph,
    decide: async (nodeRunId, kind, body = { note: 'decided in a test' }) =>
      app.request(`http://127.0.0.1:4747${API_BASE_PATH}/node-runs/${nodeRunId}/${kind}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),

    async seed(names, text = 'Tidy up the working folder.', timeoutMs) {
      const briefId = newId();
      const brief: Node = {
        id: briefId,
        workflowId,
        kind: 'input',
        name: 'Brief',
        position: { x: 0, y: 0 },
        inputs: [],
        outputs: [port(briefId, 'out')],
        config: { text, artifactIds: [], outputTypes: ['text'] },
      };
      const agents = names.map((name) => agentNode(name, timeoutMs));
      const results = agents.map(outputNode);

      await repository.workflows.create(scope, {
        id: workflowId,
        projectId: PROJECT_ID,
        name: 'Flow',
        version: 1,
        formatVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
      for (const node of [brief, ...agents, ...results]) await repository.nodes.insert(scope, node);
      for (const [index, agent] of agents.entries()) {
        const result = results[index];
        if (result === undefined) continue;
        await repository.edges.insert(scope, edge(brief, agent));
        await repository.edges.insert(scope, edge(agent, result));
      }
      return agents;
    },

    framesOf,
    waitFor,

    async waitForApproval(runId) {
      let found: RunApprovalRequest | undefined;
      await waitFor(async () => {
        const [pending] = await approvals.listPending(runId);
        if (pending === undefined) return false;
        const row = await repository.nodeRuns.get(scope, pending.nodeRunId);
        if (row?.status !== 'WAITING') return false;
        found = pending;
        return true;
      }, 'a node to go WAITING on an approval');
      if (found === undefined) throw new Error('no node went WAITING on an approval');
      return found;
    },

    async nodeRun(id) {
      const row = await repository.nodeRuns.get(scope, id);
      if (row === null) throw new Error(`no node run ${id}`);
      return row;
    },

    async nodeRunsOf(runId, nodeId) {
      return (await repository.nodeRuns.listByRun(scope, runId)).filter(
        (row) => row.nodeId === nodeId,
      );
    },

    async runRow(id) {
      const row = await repository.runs.get(scope, id);
      if (row === null) throw new Error(`no run ${id}`);
      return row;
    },
  };
}
