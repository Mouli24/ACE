import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_CONCURRENCY,
  DEFAULT_THEME,
  type Edge,
  type Node,
  type Project,
  type Settings,
  type Model,
  type NodeRun,
  type Provider,
  type Run,
  type ServerFrame,
  type Workflow,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import { catalogFor, checkOutcome } from './catalog';
import { publishMockEvent } from './event-bus';

/**
 * One event as the engine keeps it (§2.9, §2.4). Round 1 had only `workflow.updated`; round 2 adds
 * the run frames, which are routed to workflow-scope subscribers, and `provider.status`, which is
 * engine scope. `node.token` is transient: delivered live, never persisted, never replayed.
 */
export interface MockEvent {
  /** Absent on a transient frame (`node.token`), which carries no seq by contract. */
  seq?: number;
  type: ServerFrame['type'];
  payload: unknown;
  /** Which subscription delivers it; a run frame belongs to its workflow. */
  scope: 'workflow' | 'engine';
  workflowId?: string;
}

interface Snapshot {
  settings: Settings;
  projects: Project[];
  workflows: Workflow[];
  nodes: Record<string, Node[]>;
  edges: Record<string, Edge[]>;
  events: MockEvent[];
  seq: number;
  providers: Provider[];
  /** Keys never leave the mock keychain, exactly as BR-07 requires of the engine. */
  providerKeys: Record<string, string>;
  models: Model[];
  /** When the catalogue was last discovered — what `GET /models` reports (FR-MOD-006). */
  catalogRefreshedAt?: string;
  runs: Run[];
  nodeRuns: NodeRun[];
  /** Artificial delay per request, for the loading-state test (TC-CAN-009). */
  latencyMs?: number;
}

export interface MockDbOptions {
  /** Persist to localStorage so every tab of the same origin shares one engine. */
  persist?: boolean;
  storageKey?: string;
}

export const MOCK_STORAGE_KEY = 'ace.mock.db';

/** Paths the mock engine treats as unwritable (FR-PRJ-003, TC-PRJ-002). */
export function isUnwritablePath(path: string): boolean {
  return /readonly|unwritable/i.test(path);
}

const now = (): string => new Date().toISOString();

function defaultSettings(): Settings {
  return {
    dataDir: '/mock/.ace',
    concurrency: DEFAULT_CONCURRENCY,
    theme: DEFAULT_THEME,
    onboardingCompleted: false,
    allowedOrigins: [...DEFAULT_ALLOWED_ORIGINS],
  };
}

function emptySnapshot(): Snapshot {
  return {
    settings: defaultSettings(),
    projects: [],
    workflows: [],
    nodes: {},
    edges: {},
    events: [],
    seq: 0,
    providers: [],
    providerKeys: {},
    models: [],
    runs: [],
    nodeRuns: [],
  };
}

/**
 * The in-memory engine behind the MSW handlers (round 1 §5 step 10). It is deliberately dumb
 * storage; every rule (versions, validation, cycles) lives in `handlers.ts` so the handlers read
 * like the endpoint table in §2.8.
 */
export class MockDb {
  private state: Snapshot = emptySnapshot();
  private readonly persist: boolean;
  private readonly storageKey: string;

  constructor(options: MockDbOptions = {}) {
    this.persist = options.persist ?? true;
    this.storageKey = options.storageKey ?? MOCK_STORAGE_KEY;
    this.load();
  }

  get latencyMs(): number {
    return this.state.latencyMs ?? 0;
  }

  setLatency(ms: number): void {
    this.state.latencyMs = ms;
    this.save();
  }

  /** A fresh contract id (ULID), for callers building nodes or edges by hand. */
  nextId(): string {
    return newId();
  }

  /* ---------------------------------------------------------------- persistence */

  /** Re-read the shared snapshot: another tab may have written since. */
  load(): void {
    if (!this.persist) return;
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (raw) this.state = { ...emptySnapshot(), ...(JSON.parse(raw) as Snapshot) };
    } catch {
      this.state = emptySnapshot();
    }
  }

  save(): void {
    if (!this.persist) return;
    try {
      globalThis.localStorage?.setItem(this.storageKey, JSON.stringify(this.state));
    } catch {
      /* storage full or unavailable: the in-memory copy still serves this tab */
    }
  }

  reset(): void {
    this.state = emptySnapshot();
    this.save();
  }

  /* ---------------------------------------------------------------- settings */

  get settings(): Settings {
    return this.state.settings;
  }

  patchSettings(patch: Partial<Settings>): Settings {
    this.state.settings = { ...this.state.settings, ...patch };
    this.save();
    return this.state.settings;
  }

  /* ---------------------------------------------------------------- projects */

  listProjects(): Project[] {
    return [...this.state.projects];
  }

  getProject(id: string): Project | undefined {
    return this.state.projects.find((p) => p.id === id);
  }

  createProject(input: { name: string; folderPath?: string }): Project {
    const ts = now();
    const project: Project = {
      id: newId(),
      name: input.name,
      folderPath: input.folderPath ?? `/mock/projects/${input.name.replace(/[^\w-]+/g, '-')}`,
      createdAt: ts,
      updatedAt: ts,
    };
    this.state.projects.push(project);
    this.save();
    return project;
  }

  updateProject(id: string, patch: { name?: string; lastOpenedAt?: string }): Project | undefined {
    const project = this.getProject(id);
    if (!project) return undefined;
    Object.assign(project, patch, { updatedAt: now() });
    this.save();
    return project;
  }

  deleteProject(id: string): boolean {
    const before = this.state.projects.length;
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    for (const wf of this.state.workflows.filter((w) => w.projectId === id))
      this.deleteWorkflow(wf.id);
    if (this.state.settings.lastProjectId === id) delete this.state.settings.lastProjectId;
    this.save();
    return this.state.projects.length < before;
  }

  /* ---------------------------------------------------------------- workflows */

  listWorkflows(projectId: string): Workflow[] {
    return this.state.workflows.filter((w) => w.projectId === projectId);
  }

  getWorkflow(id: string): Workflow | undefined {
    return this.state.workflows.find((w) => w.id === id);
  }

  createWorkflow(projectId: string, name: string): Workflow {
    const ts = now();
    const workflow: Workflow = {
      id: newId(),
      projectId,
      name,
      version: 0,
      formatVersion: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    this.state.workflows.push(workflow);
    this.state.nodes[workflow.id] = [];
    this.state.edges[workflow.id] = [];
    this.save();
    return workflow;
  }

  updateWorkflow(id: string, patch: { name?: string }): Workflow | undefined {
    const workflow = this.getWorkflow(id);
    if (!workflow) return undefined;
    Object.assign(workflow, patch, { updatedAt: now() });
    this.save();
    return workflow;
  }

  deleteWorkflow(id: string): boolean {
    const before = this.state.workflows.length;
    this.state.workflows = this.state.workflows.filter((w) => w.id !== id);
    delete this.state.nodes[id];
    delete this.state.edges[id];
    this.save();
    return this.state.workflows.length < before;
  }

  nodesOf(workflowId: string): Node[] {
    return this.state.nodes[workflowId] ?? [];
  }

  edgesOf(workflowId: string): Edge[] {
    return this.state.edges[workflowId] ?? [];
  }

  /**
   * Commit a new graph: version + 1, and one `workflow.updated` event with the next seq.
   * `silent` skips the live broadcast (the event is still persisted for `resume`), which is how a
   * test makes this tab stale on purpose (TC-WF-005).
   */
  commitGraph(
    workflowId: string,
    nodes: Node[],
    edges: Edge[],
    options: { silent?: boolean } = {},
  ): Workflow {
    const workflow = this.getWorkflow(workflowId);
    if (!workflow) throw new Error(`unknown workflow ${workflowId}`);
    workflow.version += 1;
    workflow.updatedAt = now();
    this.state.nodes[workflowId] = nodes;
    this.state.edges[workflowId] = edges;
    this.state.seq += 1;
    const event: MockEvent = {
      seq: this.state.seq,
      type: 'workflow.updated',
      payload: { workflowId, version: workflow.version },
      scope: 'workflow',
      workflowId,
    };
    this.state.events.push(event);
    this.save();
    if (!options.silent) publishMockEvent(event);
    return workflow;
  }

  /* ---------------------------------------------------------------- providers (§2.5) */

  listProviders(): Provider[] {
    return [...this.state.providers];
  }

  getProvider(id: string): Provider | undefined {
    return this.state.providers.find((p) => p.id === id);
  }

  createProvider(input: {
    type: Provider['type'];
    name: string;
    apiKey?: string;
    baseUrl?: string;
    concurrency?: number;
  }): Provider {
    const ts = now();
    const provider: Provider = {
      id: newId(),
      type: input.type,
      name: input.name,
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      // BR-07: the key goes to the keychain, never onto the provider record
      keySet: Boolean(input.apiKey),
      status: 'UNKNOWN',
      concurrency: input.concurrency ?? DEFAULT_CONCURRENCY,
      createdAt: ts,
      updatedAt: ts,
    };
    this.state.providers.push(provider);
    if (input.apiKey) this.state.providerKeys[provider.id] = input.apiKey;
    this.state.models.push(...catalogFor(provider, ts));
    this.save();
    return provider;
  }

  updateProvider(
    id: string,
    patch: { name?: string; apiKey?: string; baseUrl?: string; concurrency?: number },
  ): Provider | undefined {
    const provider = this.getProvider(id);
    if (!provider) return undefined;
    if (patch.name !== undefined) provider.name = patch.name;
    if (patch.baseUrl !== undefined) provider.baseUrl = patch.baseUrl;
    if (patch.concurrency !== undefined) provider.concurrency = patch.concurrency;
    if (patch.apiKey !== undefined) {
      this.state.providerKeys[id] = patch.apiKey;
      provider.keySet = true;
    }
    provider.updatedAt = now();
    this.save();
    return provider;
  }

  deleteProvider(id: string): boolean {
    const before = this.state.providers.length;
    this.state.providers = this.state.providers.filter((p) => p.id !== id);
    this.state.models = this.state.models.filter((m) => m.providerId !== id);
    delete this.state.providerKeys[id];
    this.save();
    return this.state.providers.length < before;
  }

  /** Nodes that still name this provider — what the 409 `provider_in_use` lists (FR-PRV-005). */
  nodesUsingProvider(id: string): string[] {
    const used: string[] = [];
    for (const nodes of Object.values(this.state.nodes)) {
      for (const node of nodes) {
        const config = node.config as { providerId?: string };
        if (config.providerId === id) used.push(node.id);
      }
    }
    return used;
  }

  /** §2.6: the outcome is decided by the key and base URL, so every state is reproducible. */
  checkProvider(
    id: string,
  ): { status: Provider['status']; message?: string; checkedAt: string } | undefined {
    const provider = this.getProvider(id);
    if (!provider) return undefined;
    const outcome = checkOutcome(this.state.providerKeys[id], provider.baseUrl);
    const checkedAt = now();
    provider.status = outcome.status;
    if (outcome.message === undefined) delete provider.statusMessage;
    else provider.statusMessage = outcome.message;
    provider.lastCheckedAt = checkedAt;
    provider.updatedAt = checkedAt;
    this.save();
    this.emit({
      type: 'provider.status',
      payload: {
        providerId: id,
        status: outcome.status,
        ...(outcome.message === undefined ? {} : { message: outcome.message }),
      },
      scope: 'engine',
    });
    return {
      status: outcome.status,
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
      checkedAt,
    };
  }

  /**
   * Force a provider's state and announce it, the way the engine's scheduled re-check would
   * (FR-PRV-004). Only the test hooks call this; a real check goes through `checkProvider`.
   */
  setProviderStatus(
    id: string,
    status: Provider['status'],
    message?: string,
  ): Provider | undefined {
    const provider = this.getProvider(id);
    if (!provider) return undefined;
    provider.status = status;
    if (message === undefined) delete provider.statusMessage;
    else provider.statusMessage = message;
    provider.lastCheckedAt = now();
    this.save();
    this.emit({
      type: 'provider.status',
      payload: { providerId: id, status, ...(message === undefined ? {} : { message }) },
      scope: 'engine',
    });
    return provider;
  }

  /* ---------------------------------------------------------------- models */

  listModels(): Model[] {
    return [...this.state.models];
  }

  refreshModels(id: string): { models: Model[]; refreshedAt: string } | undefined {
    const provider = this.getProvider(id);
    if (!provider) return undefined;
    const refreshedAt = now();
    this.state.models = [
      ...this.state.models.filter((m) => m.providerId !== id),
      ...catalogFor(provider, refreshedAt),
    ];
    this.state.catalogRefreshedAt = refreshedAt;
    this.save();
    return { models: this.state.models.filter((m) => m.providerId === id), refreshedAt };
  }

  /**
   * When the catalogue was last discovered (FR-MOD-006). Kept on the state rather than minted per
   * request: a timestamp that always reads "now" cannot show that a refresh happened.
   */
  catalogRefreshedAt(): string {
    return (
      this.state.catalogRefreshedAt ??
      this.state.models[0]?.lastCheckedAt ??
      new Date(0).toISOString()
    );
  }

  /* ---------------------------------------------------------------- runs */

  listRuns(workflowId: string): Run[] {
    return this.state.runs
      .filter((r) => r.workflowId === workflowId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getRun(id: string): Run | undefined {
    return this.state.runs.find((r) => r.id === id);
  }

  addRun(run: Run): Run {
    this.state.runs.push(run);
    this.save();
    return run;
  }

  updateRun(id: string, patch: Partial<Run>): Run | undefined {
    const run = this.getRun(id);
    if (!run) return undefined;
    Object.assign(run, patch);
    this.save();
    return run;
  }

  listNodeRuns(runId: string): NodeRun[] {
    return this.state.nodeRuns.filter((n) => n.runId === runId);
  }

  getNodeRun(id: string): NodeRun | undefined {
    return this.state.nodeRuns.find((n) => n.id === id);
  }

  upsertNodeRun(nodeRun: NodeRun): NodeRun {
    const index = this.state.nodeRuns.findIndex((n) => n.id === nodeRun.id);
    if (index === -1) this.state.nodeRuns.push(nodeRun);
    else this.state.nodeRuns[index] = nodeRun;
    this.save();
    return nodeRun;
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Record and publish one event. A frame with a seq is persisted and therefore replayable on
   * `resume`; a transient one (`node.token`) is delivered live only (§2.4).
   */
  emit(event: Omit<MockEvent, 'seq'> & { transient?: boolean }): MockEvent {
    const { transient, ...rest } = event;
    const full: MockEvent = transient ? { ...rest } : { ...rest, seq: (this.state.seq += 1) };
    if (!transient) this.state.events.push(full);
    this.save();
    publishMockEvent(full);
    return full;
  }

  get seq(): number {
    return this.state.seq;
  }

  get events(): readonly MockEvent[] {
    return this.state.events;
  }

  /** Only persisted events replay; a transient frame has no seq and is gone once sent (§2.4). */
  eventsAfter(afterSeq: number): MockEvent[] {
    return this.state.events.filter((e) => e.seq !== undefined && e.seq > afterSeq);
  }
}
