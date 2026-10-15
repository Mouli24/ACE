import {
  DEFAULT_CLI_PERMISSION,
  DEFAULT_CONCURRENCY,
  DEFAULT_GUARDRAIL_POLICY_NAME,
  SettingsSchema,
  defaultGuardrailChecks,
  isCliProviderType,
  type ApprovalRequest,
  type CliPermission,
  type Artifact,
  type ChatMessage,
  type ChatThread,
  type Edge,
  type GuardrailCheck,
  type GuardrailPolicy,
  type KbChunk,
  type KbDocument,
  type KnowledgeBase,
  type McpServer,
  type MemoryEntry,
  type Message,
  type Node,
  type Project,
  type Settings,
  type TerminalTrust,
  type Model,
  type NodeRun,
  type FileChange,
  type Provider,
  type RepoStatus,
  type Run,
  type ServerFrame,
  type Workflow,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import { catalogFor, checkOutcome } from './catalog';
import { publishMockEvent } from './event-bus';
import { ensureFolders, type MockFs } from './files';
import { base64ToBytes, bytesToBase64, sha256Hex } from './sha256';

/**
 * One event as the engine keeps it (§2.9, §2.4). Round 1 had only `workflow.updated`; round 2 adds
 * the run frames, which are routed to workflow-scope subscribers, and `provider.status`, which is
 * engine scope. `node.token` is transient: delivered live, never persisted, never replayed.
 */
export interface MockEvent {
  /** Absent on a transient frame (`node.token`, `chat.token`), which carries no seq by contract. */
  seq?: number;
  type: ServerFrame['type'];
  payload: unknown;
  /**
   * When it was emitted (round 5): the trace's `at` (FR-OBS-001). Absent on events persisted before
   * round 5, which the trace dates from their run's start instead.
   */
  at?: string;
  /**
   * Which subscription delivers it: a run frame belongs to its workflow, a direct-chat frame to its
   * thread (round 4 §2.5), and `provider.status`/`mcp.status` to the engine scope.
   */
  scope: 'workflow' | 'engine' | 'thread' | 'project';
  /** The project a `project`-scope frame (`files.changed`) belongs to (D299). */
  projectId?: string;
  workflowId?: string;
  /** The thread a `thread`-scope frame (`chat.token`, `chat.message`) rides (round 4 §2.5). */
  threadId?: string;
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
  /** Round 3: one row per policy; a PATCH bumps its `version` (FR-GRD-001). */
  guardrailPolicies: GuardrailPolicy[];
  /** Approval requests still waiting for a decision — what `GET /runs/:id/approvals` answers. */
  approvals: ApprovalRequest[];
  /* ---- round 4 (§2.1, §2.2, §2.3) ---- */
  /** Uploaded and produced files, one row per unique hash (FR-MM-001/002). */
  artifacts: Artifact[];
  /** The content-addressed blob store: artifact hash → the bytes, base64 for JSON persistence. */
  blobs: Record<string, string>;
  /** Timeline rows (FR-CHAT-001); a message names its workflow, and optionally its run/node. */
  messages: Message[];
  /** Direct-chat threads (FR-CHAT-004); a thread belongs to one agent node. */
  chatThreads: ChatThread[];
  /** The turns of every direct-chat thread; never on a run (FR-CHAT-005). */
  chatMessages: ChatMessage[];
  /** Connected MCP servers (FR-TOOL-007); a connected one contributes tools to `GET /tools`. */
  mcpServers: McpServer[];
  /* ---- round 5 (§2.1, §2.2) ---- */
  /** Knowledge bases (FR-RAG-001); a base belongs to one project. */
  knowledgeBases: KnowledgeBase[];
  /** Documents going through, or done with, ingestion (FR-RAG-002/003). */
  kbDocuments: KbDocument[];
  /** The indexed pieces of every ready document (FR-RAG-004). */
  kbChunks: KbChunk[];
  /** Agent long-term memory, one row per (node, key) (FR-MEM-001..004). */
  memory: MemoryEntry[];
  /* ---- IDE (D299) ---- */
  /** Each project's folder, path → entry (Forge). */
  projectFiles: Record<string, MockFs>;
  /** What `GET /files/status` answers per project; `{ repo: false }` when absent. */
  repoStatus: Record<string, RepoStatus>;
  /** Artificial delay per request, for the loading-state test (TC-CAN-009). */
  latencyMs?: number;
}

/** What a backup carries (round 5 §2.7): every table, never a key (FR-SYS-012, BR-07). */
export type MockBackup = Omit<Snapshot, 'providerKeys' | 'latencyMs'>;

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

/**
 * The contract fills every default in; only `dataDir` has none. Written as a parse rather than a
 * literal so a round that adds a setting (round 4 added three) does not have to grow this by hand
 * (D209).
 */
function defaultSettings(): Settings {
  return SettingsSchema.parse({ dataDir: '/mock/.ace' });
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
    guardrailPolicies: [],
    approvals: [],
    artifacts: [],
    blobs: {},
    messages: [],
    chatThreads: [],
    chatMessages: [],
    mcpServers: [],
    knowledgeBases: [],
    kbDocuments: [],
    kbChunks: [],
    memory: [],
    projectFiles: {},
    repoStatus: {},
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
    // Every project is born with the §2.2 default policy (FR-GRD-018, D10, D77)
    this.state.guardrailPolicies.push({
      id: newId(),
      projectId: project.id,
      name: DEFAULT_GUARDRAIL_POLICY_NAME,
      version: 1,
      isProjectDefault: true,
      checks: defaultGuardrailChecks(() => newId()),
      createdAt: ts,
      updatedAt: ts,
    });
    this.save();
    return project;
  }

  updateProject(
    id: string,
    patch: {
      name?: string;
      lastOpenedAt?: string;
      maxCostPerRunUsd?: number | null;
      /** D301: the terminal trust level; the PATCH handler passes it through. */
      terminal?: TerminalTrust;
      /** D299 Phase 4: Run checks' command; `null` removes it, as the engine's store does. */
      checkCommand?: string | null;
      /** D299 Phase 4: format-on-save. */
      formatOnSave?: boolean;
    },
  ): Project | undefined {
    const project = this.getProject(id);
    if (!project) return undefined;
    Object.assign(project, patch, { updatedAt: now() });
    if (project.checkCommand === null) delete project.checkCommand;
    this.save();
    return project;
  }

  deleteProject(id: string): boolean {
    const before = this.state.projects.length;
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    this.state.guardrailPolicies = this.state.guardrailPolicies.filter(
      (policy) => policy.projectId !== id,
    );
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
    cliPermission?: CliPermission;
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
      ...(isCliProviderType(input.type)
        ? { cliPermission: input.cliPermission ?? DEFAULT_CLI_PERMISSION }
        : {}),
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
    patch: {
      name?: string;
      apiKey?: string;
      baseUrl?: string;
      concurrency?: number;
      cliPermission?: CliPermission;
    },
  ): Provider | undefined {
    const provider = this.getProvider(id);
    if (!provider) return undefined;
    if (patch.name !== undefined) provider.name = patch.name;
    if (patch.baseUrl !== undefined) provider.baseUrl = patch.baseUrl;
    if (patch.concurrency !== undefined) provider.concurrency = patch.concurrency;
    if (patch.cliPermission !== undefined) provider.cliPermission = patch.cliPermission;
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

  /* ------------------------------------------------- guardrail policies (round 3 §2.5) */

  listPolicies(projectId?: string): GuardrailPolicy[] {
    return this.state.guardrailPolicies.filter(
      (policy) => projectId === undefined || policy.projectId === projectId,
    );
  }

  getPolicy(id: string): GuardrailPolicy | undefined {
    return this.state.guardrailPolicies.find((policy) => policy.id === id);
  }

  /** The policy a node run is checked against when no agent overrides it (FR-GRD-002). */
  projectDefaultPolicy(projectId: string): GuardrailPolicy | undefined {
    return this.state.guardrailPolicies.find(
      (policy) => policy.projectId === projectId && policy.isProjectDefault,
    );
  }

  createPolicy(input: {
    projectId: string;
    name: string;
    checks: GuardrailCheck[];
  }): GuardrailPolicy {
    const ts = now();
    const policy: GuardrailPolicy = {
      id: newId(),
      projectId: input.projectId,
      name: input.name,
      version: 1,
      // the engine owns the default flag: it is moved with set-default, never set on create (D78)
      isProjectDefault: false,
      checks: input.checks,
      createdAt: ts,
      updatedAt: ts,
    };
    this.state.guardrailPolicies.push(policy);
    this.save();
    return policy;
  }

  /** A PATCH never edits a version in place: it writes version + 1 (FR-GRD-001, Arch §13.4). */
  patchPolicy(
    id: string,
    patch: { name?: string; checks?: GuardrailCheck[] },
  ): GuardrailPolicy | undefined {
    const policy = this.getPolicy(id);
    if (!policy) return undefined;
    if (patch.name !== undefined) policy.name = patch.name;
    if (patch.checks !== undefined) policy.checks = patch.checks;
    policy.version += 1;
    policy.updatedAt = now();
    this.save();
    return policy;
  }

  deletePolicy(id: string): boolean {
    const before = this.state.guardrailPolicies.length;
    this.state.guardrailPolicies = this.state.guardrailPolicies.filter(
      (policy) => policy.id !== id,
    );
    this.save();
    return this.state.guardrailPolicies.length < before;
  }

  /** One default per project: the flag moves rather than being added (FR-GRD-018). */
  setProjectDefaultPolicy(id: string): GuardrailPolicy | undefined {
    const policy = this.getPolicy(id);
    if (!policy) return undefined;
    for (const other of this.state.guardrailPolicies) {
      if (other.projectId !== policy.projectId) continue;
      other.isProjectDefault = other.id === id;
    }
    policy.updatedAt = now();
    this.save();
    return policy;
  }

  /** Agent nodes that override with this policy — what the 409 `policy_in_use` lists (D78). */
  nodesUsingPolicy(id: string): string[] {
    const used: string[] = [];
    for (const nodes of Object.values(this.state.nodes)) {
      for (const node of nodes) {
        const config = node.config as { guardrailPolicyId?: string };
        if (config.guardrailPolicyId === id) used.push(node.id);
      }
    }
    return used;
  }

  /* ------------------------------------------------- approvals (round 3 §2.5, FR-GRD-013) */

  addApproval(request: ApprovalRequest): ApprovalRequest {
    this.state.approvals.push(request);
    this.save();
    return request;
  }

  /** Pending only: a decided request is removed, so this list is what still needs an answer. */
  pendingApprovals(runId: string): ApprovalRequest[] {
    return this.state.approvals.filter((request) => request.runId === runId);
  }

  pendingApprovalForNodeRun(nodeRunId: string): ApprovalRequest | undefined {
    return this.state.approvals.find((request) => request.nodeRunId === nodeRunId);
  }

  resolveApproval(requestId: string): boolean {
    const before = this.state.approvals.length;
    this.state.approvals = this.state.approvals.filter((request) => request.id !== requestId);
    this.save();
    return this.state.approvals.length < before;
  }

  /* ------------------------------------------------- artifacts (round 4 §2.1, FR-MM-001/002) */

  listArtifacts(): Artifact[] {
    return [...this.state.artifacts];
  }

  getArtifact(id: string): Artifact | undefined {
    return this.state.artifacts.find((artifact) => artifact.id === id);
  }

  getArtifactByHash(hash: string): Artifact | undefined {
    return this.state.artifacts.find((artifact) => artifact.hash === hash);
  }

  /** The stored bytes of an artifact, decoded from the content-addressed blob store. */
  artifactBytes(id: string): Uint8Array | undefined {
    const artifact = this.getArtifact(id);
    if (artifact === undefined) return undefined;
    const base64 = this.state.blobs[artifact.hash];
    return base64 === undefined ? undefined : base64ToBytes(base64);
  }

  /**
   * Store bytes as an artifact, content-addressed by their sha256 (FR-MM-002): the same bytes twice
   * answer the same id and are kept once. `name` and `mime` come from the upload; a second upload of
   * identical bytes under a different name keeps the first row, exactly as the engine dedupes.
   */
  putArtifact(input: { mime: string; name: string; bytes: Uint8Array }): Artifact {
    const hash = sha256Hex(input.bytes);
    const existing = this.getArtifactByHash(hash);
    if (existing !== undefined) {
      existing.lastReferencedAt = now();
      this.save();
      return existing;
    }
    const artifact: Artifact = {
      id: newId(),
      hash,
      mime: input.mime,
      name: input.name,
      size: input.bytes.length,
      createdAt: now(),
    };
    this.state.artifacts.push(artifact);
    this.state.blobs[hash] = bytesToBase64(input.bytes);
    this.save();
    return artifact;
  }

  /**
   * Store a pre-built artifact record and its bytes as-is — what a scenario uses so the `Part` it
   * already emitted (with this id) resolves. Unlike `putArtifact` it does not dedupe: the part's id
   * must be the row's id, and a run that produces the same fixture twice is harmless in the mock.
   */
  insertArtifact(artifact: Artifact, bytes: Uint8Array): Artifact {
    if (this.getArtifact(artifact.id) === undefined) this.state.artifacts.push(artifact);
    this.state.blobs[artifact.hash] = bytesToBase64(bytes);
    this.save();
    return artifact;
  }

  /* ------------------------------------------------- timeline messages (round 4 §2.3, FR-CHAT-001) */

  messagesOf(workflowId: string): Message[] {
    return this.state.messages.filter((message) => message.workflowId === workflowId);
  }

  addMessage(message: Message): Message {
    this.state.messages.push(message);
    this.save();
    return message;
  }

  /* ------------------------------------------------- direct chat (round 4 §2.3, FR-CHAT-004/005) */

  chatThreadsOf(nodeId: string): ChatThread[] {
    return this.state.chatThreads
      .filter((thread) => thread.nodeId === nodeId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getChatThread(id: string): ChatThread | undefined {
    return this.state.chatThreads.find((thread) => thread.id === id);
  }

  addChatThread(thread: ChatThread): ChatThread {
    this.state.chatThreads.push(thread);
    this.save();
    return thread;
  }

  touchChatThread(id: string): void {
    const thread = this.getChatThread(id);
    if (thread === undefined) return;
    thread.updatedAt = now();
    this.save();
  }

  deleteChatThread(id: string): boolean {
    const before = this.state.chatThreads.length;
    this.state.chatThreads = this.state.chatThreads.filter((thread) => thread.id !== id);
    this.state.chatMessages = this.state.chatMessages.filter((message) => message.threadId !== id);
    this.save();
    return this.state.chatThreads.length < before;
  }

  chatMessagesOf(threadId: string): ChatMessage[] {
    return this.state.chatMessages.filter((message) => message.threadId === threadId);
  }

  /** PG-1.6 (D352): set a turn's `supersededAt`/`deletedAt`; nothing else about it changes. */
  markChatMessage(
    id: string,
    patch: { supersededAt?: string; deletedAt?: string },
  ): ChatMessage | undefined {
    const index = this.state.chatMessages.findIndex((message) => message.id === id);
    const current = this.state.chatMessages[index];
    if (current === undefined) return undefined;
    const next: ChatMessage = { ...current, ...patch };
    this.state.chatMessages[index] = next;
    this.save();
    return next;
  }

  addChatMessage(message: ChatMessage): ChatMessage {
    this.state.chatMessages.push(message);
    this.touchChatThread(message.threadId);
    this.save();
    return message;
  }

  /* ------------------------------------------------- MCP servers (round 4 §2.2, FR-TOOL-007) */

  listMcpServers(): McpServer[] {
    return [...this.state.mcpServers];
  }

  getMcpServer(id: string): McpServer | undefined {
    return this.state.mcpServers.find((server) => server.id === id);
  }

  addMcpServer(server: McpServer): McpServer {
    this.state.mcpServers.push(server);
    this.save();
    return server;
  }

  updateMcpServer(id: string, patch: Partial<McpServer>): McpServer | undefined {
    const server = this.getMcpServer(id);
    if (server === undefined) return undefined;
    Object.assign(server, patch);
    this.save();
    return server;
  }

  deleteMcpServer(id: string): boolean {
    const before = this.state.mcpServers.length;
    this.state.mcpServers = this.state.mcpServers.filter((server) => server.id !== id);
    this.save();
    return this.state.mcpServers.length < before;
  }

  /* ------------------------------------------------- knowledge (round 5 §2.1, FR-RAG-001..009) */

  listKnowledgeBases(projectId: string): KnowledgeBase[] {
    return this.state.knowledgeBases.filter((kb) => kb.projectId === projectId);
  }

  getKnowledgeBase(id: string): KnowledgeBase | undefined {
    return this.state.knowledgeBases.find((kb) => kb.id === id);
  }

  addKnowledgeBase(kb: KnowledgeBase): KnowledgeBase {
    this.state.knowledgeBases.push(kb);
    this.save();
    return kb;
  }

  updateKnowledgeBase(id: string, patch: Partial<KnowledgeBase>): KnowledgeBase | undefined {
    const kb = this.getKnowledgeBase(id);
    if (kb === undefined) return undefined;
    Object.assign(kb, patch, { updatedAt: now() });
    this.save();
    return kb;
  }

  /** Removes the base with its documents and chunks (§2.9: delete removes chunks + vectors). */
  deleteKnowledgeBase(id: string): boolean {
    const before = this.state.knowledgeBases.length;
    this.state.knowledgeBases = this.state.knowledgeBases.filter((kb) => kb.id !== id);
    this.state.kbDocuments = this.state.kbDocuments.filter((doc) => doc.knowledgeBaseId !== id);
    this.state.kbChunks = this.state.kbChunks.filter((chunk) => chunk.knowledgeBaseId !== id);
    this.save();
    return this.state.knowledgeBases.length < before;
  }

  kbDocumentsOf(knowledgeBaseId: string): KbDocument[] {
    return this.state.kbDocuments.filter((doc) => doc.knowledgeBaseId === knowledgeBaseId);
  }

  getKbDocument(id: string): KbDocument | undefined {
    return this.state.kbDocuments.find((doc) => doc.id === id);
  }

  addKbDocument(doc: KbDocument): KbDocument {
    this.state.kbDocuments.push(doc);
    this.save();
    return doc;
  }

  updateKbDocument(id: string, patch: Partial<KbDocument>): KbDocument | undefined {
    const doc = this.getKbDocument(id);
    if (doc === undefined) return undefined;
    Object.assign(doc, patch);
    this.save();
    return doc;
  }

  /** Removes the document and its chunks (FR-RAG-009). */
  deleteKbDocument(id: string): boolean {
    const before = this.state.kbDocuments.length;
    this.state.kbDocuments = this.state.kbDocuments.filter((doc) => doc.id !== id);
    this.state.kbChunks = this.state.kbChunks.filter((chunk) => chunk.documentId !== id);
    this.save();
    return this.state.kbDocuments.length < before;
  }

  kbChunksOf(knowledgeBaseId: string): KbChunk[] {
    return this.state.kbChunks.filter((chunk) => chunk.knowledgeBaseId === knowledgeBaseId);
  }

  /** Replace one document's chunks — what an ingest or a reindex writes. */
  setKbChunks(documentId: string, chunks: KbChunk[]): void {
    this.state.kbChunks = [
      ...this.state.kbChunks.filter((chunk) => chunk.documentId !== documentId),
      ...chunks,
    ];
    this.save();
  }

  /* ------------------------------------------------- memory (round 5 §2.2, FR-MEM-001..004) */

  /** Oldest first — the order entries are injected in (§2.2). */
  memoryOf(nodeId: string): MemoryEntry[] {
    return this.state.memory
      .filter((entry) => entry.nodeId === nodeId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** A save of a key the node already has replaces the value (FR-MEM-002). */
  saveMemory(nodeId: string, key: string, value: string, at?: string): MemoryEntry {
    const ts = at ?? now();
    const existing = this.state.memory.find(
      (entry) => entry.nodeId === nodeId && entry.key === key,
    );
    if (existing !== undefined) {
      existing.value = value;
      existing.updatedAt = ts;
      this.save();
      return existing;
    }
    const entry: MemoryEntry = { id: newId(), nodeId, key, value, createdAt: ts, updatedAt: ts };
    this.state.memory.push(entry);
    this.save();
    return entry;
  }

  /** Removes one entry, matched by id or by key; answers what it removed. */
  deleteMemory(nodeId: string, match: { id?: string; key?: string }): MemoryEntry | undefined {
    const entry = this.state.memory.find(
      (candidate) =>
        candidate.nodeId === nodeId &&
        (match.id === undefined || candidate.id === match.id) &&
        (match.key === undefined || candidate.key === match.key),
    );
    if (entry === undefined) return undefined;
    this.state.memory = this.state.memory.filter((candidate) => candidate.id !== entry.id);
    this.save();
    return entry;
  }

  /** Stamp `lastUsedAt` on a node's entries — they just went into an envelope. */
  touchMemory(nodeId: string): void {
    const ts = now();
    for (const entry of this.state.memory) if (entry.nodeId === nodeId) entry.lastUsedAt = ts;
    this.save();
  }

  /** A node of any workflow — `GET /nodes/:id/memory` asks whether the node exists. */
  findNode(id: string): Node | undefined {
    for (const nodes of Object.values(this.state.nodes)) {
      const found = nodes.find((node) => node.id === id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Every run of every workflow — what usage and health metrics fold (round 5 §2.6). */
  allRuns(): Run[] {
    return [...this.state.runs];
  }

  allNodeRuns(): NodeRun[] {
    return [...this.state.nodeRuns];
  }

  /* ------------------------------------------------- backup (round 5 §2.7, FR-SYS-012) */

  /** Every table but the keychain: a backup never carries a key (BR-07). */
  exportBackup(): MockBackup {
    const backup: Partial<Snapshot> = structuredClone(this.state);
    delete backup.providerKeys;
    delete backup.latencyMs;
    return backup as MockBackup;
  }

  /**
   * Replace every table with the backup's. The keychain is not part of a data dir, so the keys this
   * engine already holds stay where they are.
   */
  importBackup(backup: MockBackup): void {
    const latencyMs = this.state.latencyMs;
    this.state = {
      ...emptySnapshot(),
      ...structuredClone(backup),
      providerKeys: this.state.providerKeys,
      ...(latencyMs === undefined ? {} : { latencyMs }),
    };
    this.save();
  }

  /* ------------------------------------------------------------ files (D299) */

  /** A project's folder, created empty on first use. */
  filesOf(projectId: string): MockFs {
    const folders = this.state.projectFiles;
    folders[projectId] ??= {};
    return folders[projectId];
  }

  /** Put files in a project's folder (tests, `__aceMock.seedFiles`); parent folders appear too. */
  seedFiles(projectId: string, files: Record<string, string>): void {
    const fs = this.filesOf(projectId);
    const at = new Date().toISOString();
    for (const [path, content] of Object.entries(files)) {
      ensureFolders(fs, path);
      fs[path] = { kind: 'file', content, mtime: at };
    }
    this.save();
  }

  /** Change a file the way an agent or another editor would, and announce it like the watcher. */
  writeFileExternally(projectId: string, path: string, content: string): void {
    const fs = this.filesOf(projectId);
    const existed = fs[path] !== undefined;
    ensureFolders(fs, path);
    fs[path] = { kind: 'file', content, mtime: new Date().toISOString() };
    this.save();
    this.emitFilesChanged(projectId, [{ path, kind: existed ? 'changed' : 'created' }]);
  }

  deleteFileExternally(projectId: string, path: string): void {
    delete this.filesOf(projectId)[path];
    this.save();
    this.emitFilesChanged(projectId, [{ path, kind: 'deleted' }]);
  }

  repoStatusOf(projectId: string): RepoStatus {
    return this.state.repoStatus[projectId] ?? { repo: false };
  }

  setRepoStatus(projectId: string, status: RepoStatus): void {
    this.state.repoStatus[projectId] = status;
    this.save();
  }

  /** The watcher's frame: transient, on the project's scope, paths only. */
  emitFilesChanged(projectId: string, changes: FileChange[]): void {
    this.emit({
      type: 'files.changed',
      payload: { projectId, changes, resync: false },
      scope: 'project',
      projectId,
      transient: true,
    });
  }

  /* ---------------------------------------------------------------- events */

  /**
   * Record and publish one event. A frame with a seq is persisted and therefore replayable on
   * `resume`; a transient one (`node.token`) is delivered live only (§2.4).
   */
  emit(event: Omit<MockEvent, 'seq'> & { transient?: boolean }): MockEvent {
    const { transient, ...rest } = event;
    const full: MockEvent = transient
      ? { ...rest }
      : { ...rest, seq: (this.state.seq += 1), at: rest.at ?? now() };
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
