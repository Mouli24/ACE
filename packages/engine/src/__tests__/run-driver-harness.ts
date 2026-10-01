import {
  AgentConfigSchema,
  type Edge,
  type Model,
  type Node,
  type NodeRun,
  type NodeState,
  type Provider,
  type Run,
} from '@ace/contracts';

import { createEventBus, type EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type ModelRouter,
  type ProviderAdapter,
  type SecretStore,
  type StreamChunk,
} from '../ports/index.js';
import { createProviderService, type ProviderService } from '../providers/index.js';
import {
  controlStoresFor,
  createRunControls,
  createRunGateRegistry,
  createRunService,
  type RunControls,
  type RunGateRegistry,
  type RunService,
} from '../runs/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

/**
 * The run driver and the run controls wired the way `apps/server` wires them (FR-CTL-001..003,
 * FR-ERR-005..007), on a scripted provider.
 *
 * Everything that decides behaviour is the real thing: the run service, the controls, the gate
 * registry they share, and the provider service's own per-provider semaphore (FR-PRV-009) — only the
 * store (in memory) and the model (scripted) are stand-ins. A control test that replaced the
 * semaphore or the controls with a stub would be testing the stub.
 */

export const scope = LOCAL_SCOPE;
export const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const NOW = '2026-09-29T10:00:00.000Z';

/** One scripted answer to one `generate()` call. */
export interface Step {
  /** The answer, when it answers. */
  text?: string;
  /** Thrown after the hold (if any): a 503 is `{ status: 503 }`, a 401 `{ status: 401 }`. */
  throws?: unknown;
  /** Yielded before anything else, so a call cut short has still spent something. */
  usageFirst?: { tokensIn: number; tokensOut: number };
  /** Hold the stream open until this settles, or until the call's signal aborts. */
  hold?: Promise<void>;
  /**
   * Runs once the caller has taken the stream's last chunk, as the call returns — so a stop made
   * here lands after `generate()` finished and before its result is recorded (D-063).
   */
  afterFinish?: () => void;
}

export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A stream that never ends by itself: only the abort closes it. */
export const untilAborted = (): Promise<void> => new Promise<void>(() => undefined);

export const httpError = (status: number, message = `HTTP ${status}`): Error =>
  Object.assign(new Error(message), { status });

export interface RunDriverHarness {
  repository: FakeRepository;
  bus: EventBus;
  events: EngineEvent[];
  gates: RunGateRegistry;
  providers: ProviderService;
  service: RunService;
  controls: RunControls;
  workflowId: string;

  /** Scripts by node name: each call takes the next step, and the last one repeats. */
  scripts: Map<string, Step[]>;
  /** `generate()` calls per node name. */
  calls: (name: string) => number;
  /** Whether each call was handed an already-aborted signal, by node name. */
  abortedAtCall: (name: string) => boolean[];
  /** The runs whose pending approvals the run service rejected because the run ended (FR-GRD-013). */
  approvalsCancelledFor: string[];

  inputNode(name?: string): Node;
  agentNode(name: string, execution?: Record<string, unknown>): Node;
  outputNode(name?: string): Node;
  edge(from: Node, to: Node): Edge;
  seed(nodes: Node[], edges: Edge[]): Promise<void>;

  nodeRunsOf(runId: string, nodeId?: string): Promise<NodeRun[]>;
  /** The `node.state` frames of one node, as `attempt:STATUS`, in the order they were emitted. */
  framesOf(nodeId: string): string[];
  /** Index of the first event of this type, or -1. */
  indexOf(type: string): number;
  waitFor(predicate: () => boolean, label: string): Promise<void>;
  /** Resolves once this node has emitted this state on this attempt. */
  waitForState(nodeId: string, status: NodeState, attempt?: number): Promise<void>;
  runRow(runId: string): Promise<Run>;
}

export async function createRunDriverHarness(
  options: {
    providerConcurrency?: number;
    /** Runs when the run service rejects a run's pending approvals — a test can make it throw. */
    onCancelPending?: (runId: string) => void;
  } = {},
): Promise<RunDriverHarness> {
  const repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub });
  const events: EngineEvent[] = [];
  await bus.subscribe((event) => events.push(event));

  const workflowId = newId();
  const scripts = new Map<string, Step[]>();
  const callCounts = new Map<string, number>();
  const abortedAt = new Map<string, boolean[]>();

  const provider: Provider = {
    id: PROVIDER_ID,
    type: 'mock',
    name: 'Scripted',
    keySet: false,
    status: 'CONNECTED',
    concurrency: options.providerConcurrency ?? 20,
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
    supportsTools: false,
    supportsJson: false,
    available: true,
    source: 'discovered',
    lastCheckedAt: NOW,
    pricing: { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
  };
  await repository.providers.create(scope, provider);
  await repository.models.replaceForProvider(scope, PROVIDER_ID, [model]);
  await repository.settings.update(scope, { dataDir: '/tmp/ace', concurrency: 20 });

  /** Which node a call belongs to: every agent is instructed "Act as <name>." */
  const nameIn = (text: string): string => /Act as (\w+)\./.exec(text)?.[1] ?? 'unknown';

  const nextStep = (name: string): Step => {
    const steps = scripts.get(name) ?? [{ text: 'ok' }];
    const index = Math.min((callCounts.get(name) ?? 1) - 1, steps.length - 1);
    return steps[index] ?? { text: 'ok' };
  };

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
      const name = nameIn(`${request.system ?? ''}\n${request.prompt}`);
      callCounts.set(name, (callCounts.get(name) ?? 0) + 1);
      abortedAt.set(name, [...(abortedAt.get(name) ?? []), signal.aborted]);
      const step = nextStep(name);

      return (async function* (): AsyncGenerator<StreamChunk> {
        if (step.usageFirst !== undefined) yield { type: 'usage', ...step.usageFirst };
        if (step.hold !== undefined) await holdOrAbort(step.hold, signal);
        else await Promise.resolve();
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (step.throws !== undefined) throw step.throws;
        yield { type: 'text', delta: step.text ?? 'ok' };
        yield { type: 'usage', tokensIn: 2, tokensOut: 3 };
        yield { type: 'finish', reason: 'stop' };
        step.afterFinish?.();
      })();
    },
  };

  const secrets: SecretStore = {
    isAvailable: async () => true,
    get: async () => null,
    set: async () => undefined,
    delete: async () => false,
  };

  const providers = createProviderService({
    repository,
    scope,
    secrets,
    factory: {
      create: () => adapter,
      manifestFor: () => [],
      mergeCatalog: (discovered) => discovered.map((info) => ({ ...info, source: 'discovered' as const })),
      detect: async () => ({}),
    },
    bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
  });

  /* Like the real router: a model that already failed on this node run is not offered again. */
  const router: ModelRouter = {
    resolve: (_node, _requirements, state) =>
      state.failures.length > 0
        ? { ok: false, code: 'no_candidate_left', reason: 'every model was tried' }
        : { ok: true, route: { providerId: PROVIDER_ID, modelId: 'scripted', viaFallback: false } },
    resolveForBench: () => ({ ok: false, code: 'policy_not_allowed', reason: 'not benched' }),
  };

  const gates = createRunGateRegistry();
  const approvalsCancelledFor: string[] = [];
  const service = createRunService({
    gates,
    repository,
    scope,
    bus,
    approvals: {
      cancelPending: async (runId) => {
        options.onCancelPending?.(runId);
        approvalsCancelledFor.push(runId);
        return [];
      },
    },
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    router,
    adapterFor: (providerId) => providers.adapterFor(providerId),
    checkProvider: async () => ({ status: 'CONNECTED', checkedAt: NOW }),
    runGated: async (providerId, fn) => (await providers.semaphoreFor(providerId)).run(fn),
    recordProviderStatus: (providerId, found) => providers.recordStatus(providerId, found),
    tokenBatchMs: 0,
  });

  const controls = createRunControls({
    ...controlStoresFor(repository, scope),
    bus,
    gates,
    driveRecordedRun: (run) => service.driveRecordedRun(run),
    drivePartialRun: (plan) => service.drivePartialRun(plan),
    envelopesFor: (run, nodeId) => service.envelopesFor(run, nodeId),
  });

  const port = (nodeId: string, dir: 'in' | 'out', multi = false) => ({
    id: `${nodeId}:${dir}:text`,
    name: 'text',
    dataType: 'text' as const,
    multi,
  });

  const framesOf = (nodeId: string): string[] =>
    events
      .filter((event) => event.type === 'node.state')
      .map((event) => event.payload as { nodeId: string; status: NodeState; attempt: number })
      .filter((payload) => payload.nodeId === nodeId)
      .map((payload) => `${payload.attempt}:${payload.status}`);

  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  return {
    repository,
    bus,
    events,
    gates,
    providers,
    service,
    controls,
    workflowId,
    scripts,
    calls: (name) => callCounts.get(name) ?? 0,
    abortedAtCall: (name) => abortedAt.get(name) ?? [],
    approvalsCancelledFor,

    inputNode(name = 'Brief') {
      const id = newId();
      return {
        id,
        workflowId,
        kind: 'input',
        name,
        position: { x: 0, y: 0 },
        inputs: [],
        outputs: [port(id, 'out', true)],
        config: { text: 'the brief', artifactIds: [], outputTypes: ['text'] },
      };
    },

    agentNode(name, execution = {}) {
      const id = newId();
      return {
        id,
        workflowId,
        kind: 'agent',
        name,
        position: { x: 0, y: 0 },
        inputs: [port(id, 'in')],
        outputs: [port(id, 'out', true)],
        config: AgentConfigSchema.parse({
          providerId: PROVIDER_ID,
          modelId: 'scripted',
          instructions: `Act as ${name}.`,
          inputTypes: ['text'],
          outputTypes: ['text'],
          execution: { retries: 0, ...execution },
        }),
      };
    },

    outputNode(name = 'Result') {
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
    },

    edge: (from, to) => ({
      id: newId(),
      workflowId,
      kind: 'data',
      from: { nodeId: from.id, portId: from.outputs[0]?.id ?? `${from.id}:out:text` },
      to: { nodeId: to.id, portId: to.inputs[0]?.id ?? `${to.id}:in:text` },
    }),

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

    async nodeRunsOf(runId, nodeId) {
      const rows = await repository.nodeRuns.listByRun(scope, runId);
      return rows
        .filter((row) => nodeId === undefined || row.nodeId === nodeId)
        .sort((a, b) => a.iteration - b.iteration || a.attempt - b.attempt);
    },

    framesOf,
    indexOf: (type) => events.findIndex((event) => event.type === type),
    waitFor,
    waitForState: (nodeId, status, attempt = 1) =>
      waitFor(
        () => framesOf(nodeId).includes(`${attempt}:${status}`),
        `${nodeId} attempt ${attempt} to be ${status}`,
      ),

    async runRow(runId) {
      const row = await repository.runs.get(scope, runId);
      if (row === null) throw new Error(`no run ${runId}`);
      return row;
    },
  };
}
