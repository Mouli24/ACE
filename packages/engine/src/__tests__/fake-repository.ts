import {
  DEFAULT_GUARDRAIL_POLICY_NAME,
  NodeStateSchema,
  SettingsSchema,
  THREAD_EVENT_TYPES,
  defaultGuardrailChecks,
  modelMatchesQuery,
  type ApprovalDecision,
  type ApprovalRequest,
  type CheckCommand,
  type Artifact,
  type ChatMessage,
  type ChatThread,
  type CursorQuery,
  type ErrorKind,
  type Edge,
  type GuardrailPolicy,
  type HealthMetrics,
  type Id,
  type KbChunk,
  type KbDocument,
  type KnowledgeBase,
  type McpServer,
  type MemoryEntry,
  type Message,
  type MessageQuery,
  type Model,
  type ModelQuery,
  type Node,
  type NodeRun,
  type Page,
  type Project,
  type Provider,
  type Run,
  type Settings,
  type SettingsPatch,
  type Timestamp,
  type ToolCall,
  type Usage,
  type UsageBucket,
  type UsageQuery,
  type UsageResponse,
  type Verdict,
  type Workflow,
  ERROR_KINDS,
} from '@ace/contracts';

import type {
  EngineEvent,
  EventFilter,
  GuardrailPolicyPatch,
  KbChunkRepository,
  KbDocumentRepository,
  KnowledgeBaseRepository,
  McpServerPatch,
  MemoryRepository,
  NewEngineEvent,
  NodeRunPatch,
  PriceTable,
  ProviderPatch,
  Repository,
  RunPatch,
  Scope,
  StoredApproval,
  SummaryCacheRepository,
  UsageRepository,
} from '../ports/index.js';
import { newId } from '../ids.js';
import { namesKnowledgeBase } from '../knowledge/service.js';

interface State {
  projects: Map<string, Project>;
  workflows: Map<string, Workflow>;
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
  events: EngineEvent[];
  settings: Settings | null;
  nextSeq: number;
  providers: Map<string, Provider>;
  models: Map<string, Model>;
  priceTables: Map<string, PriceTable>;
  runs: Map<string, Run>;
  nodeRuns: Map<string, NodeRun>;
  guardrailPolicies: Map<string, GuardrailPolicy>;
  guardrailVerdicts: Verdict[];
  approvals: Map<string, StoredApproval>;
  artifacts: Map<string, Artifact>;
  /** The `ToolCall` contract carries only `nodeRunId`, so the run it belongs to is kept alongside. */
  toolCalls: { runId: string; call: ToolCall }[];
  mcpServers: Map<string, McpServer>;
  messages: Map<string, Message>;
  chatThreads: Map<string, ChatThread>;
  chatMessages: Map<string, ChatMessage>;
  knowledgeBases: Map<string, KnowledgeBase>;
  kbDocuments: Map<string, KbDocument>;
  /** A chunk and the embedding stored with it, as `kb_chunks` and `kb_vectors` are written together. */
  kbChunks: Map<string, { chunk: KbChunk; embedding: number[] }>;
  memory: Map<string, MemoryEntry>;
  summaryCache: Map<string, { summary: string; createdAt: Timestamp; lastUsedAt: Timestamp }>;
}

function emptyState(): State {
  return {
    projects: new Map(),
    workflows: new Map(),
    nodes: new Map(),
    edges: new Map(),
    events: [],
    settings: null,
    nextSeq: 1,
    providers: new Map(),
    models: new Map(),
    priceTables: new Map(),
    runs: new Map(),
    nodeRuns: new Map(),
    guardrailPolicies: new Map(),
    guardrailVerdicts: [],
    approvals: new Map(),
    artifacts: new Map(),
    toolCalls: [],
    mcpServers: new Map(),
    messages: new Map(),
    chatThreads: new Map(),
    chatMessages: new Map(),
    knowledgeBases: new Map(),
    kbDocuments: new Map(),
    kbChunks: new Map(),
    memory: new Map(),
    summaryCache: new Map(),
  };
}

function cloneState(state: State): State {
  return {
    projects: new Map(state.projects),
    workflows: new Map(state.workflows),
    nodes: new Map(state.nodes),
    edges: new Map(state.edges),
    events: [...state.events],
    settings: state.settings,
    nextSeq: state.nextSeq,
    providers: new Map(state.providers),
    models: new Map(state.models),
    priceTables: new Map(state.priceTables),
    runs: new Map(state.runs),
    nodeRuns: new Map(state.nodeRuns),
    guardrailPolicies: new Map(state.guardrailPolicies),
    guardrailVerdicts: [...state.guardrailVerdicts],
    approvals: new Map(state.approvals),
    artifacts: new Map(state.artifacts),
    toolCalls: [...state.toolCalls],
    mcpServers: new Map(state.mcpServers),
    messages: new Map(state.messages),
    chatThreads: new Map(state.chatThreads),
    chatMessages: new Map(state.chatMessages),
    knowledgeBases: new Map(state.knowledgeBases),
    kbDocuments: new Map(state.kbDocuments),
    kbChunks: new Map(state.kbChunks),
    memory: new Map(state.memory),
    summaryCache: new Map(state.summaryCache),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** `summary_cache` entries unused for this long read as absent (Arch §12.8). */
const SUMMARY_CACHE_TTL_MS = 30 * DAY_MS;
/** `summary_cache` is pruned to this many rows, least recently used first. */
const SUMMARY_CACHE_MAX_ROWS = 5000;

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1]!;
}

function emptyUsage(): Usage {
  return { tokensIn: 0, tokensOut: 0, costUsd: 0 };
}

function page<T>(rows: T[], query: CursorQuery, idOf: (row: T) => string): Page<T> {
  const after = query.cursor;
  const ordered = [...rows].sort((a, b) => idOf(a).localeCompare(idOf(b)));
  const start = after === undefined ? 0 : ordered.findIndex((row) => idOf(row) > after);
  const from = start === -1 ? ordered.length : start;
  const slice = ordered.slice(from, from + query.limit + 1);

  if (slice.length <= query.limit) return { items: slice };
  const items = slice.slice(0, query.limit);
  return { items, nextCursor: idOf(items[items.length - 1]!) };
}

/**
 * An in-memory `Repository` for engine tests.
 *
 * The engine is only allowed to know its ports (CLAUDE.md §3.4 rule 3), so its tests run against
 * this rather than SQLite; the real adapter is covered in `packages/storage-local`, and the two
 * meet for real in `tests/acceptance`. `transaction` snapshots and restores on throw, so a test
 * that relies on rollback behaves the same here as it does on SQLite.
 */
export class FakeRepository implements Repository {
  #depth = 0;

  /** Rows keyed per workspace, so a scope leak shows up as a missing row rather than silently passing. */
  readonly #byWorkspace = new Map<string, State>();

  #for(scope: Scope): State {
    let state = this.#byWorkspace.get(scope.workspaceId);
    if (state === undefined) {
      state = emptyState();
      this.#byWorkspace.set(scope.workspaceId, state);
    }
    return state;
  }

  /** The highest stored version of one policy — what every read of a policy answers. */
  #latestPolicy(scope: Scope, id: Id): GuardrailPolicy | null {
    const rows = [...this.#for(scope).guardrailPolicies.values()]
      .filter((policy) => policy.id === id)
      .sort((a, b) => a.version - b.version);
    return rows.at(-1) ?? null;
  }

  async transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T> {
    if (this.#depth > 0) return fn(this);

    const snapshot = new Map(
      [...this.#byWorkspace].map(([key, state]) => [key, cloneState(state)] as const),
    );
    this.#depth += 1;
    try {
      return await fn(this);
    } catch (error) {
      this.#byWorkspace.clear();
      for (const [key, state] of snapshot) this.#byWorkspace.set(key, state);
      throw error;
    } finally {
      this.#depth -= 1;
    }
  }

  readonly projects = {
    /** Creates the default guardrail policy with the project, as the real adapter does (FR-GRD-018). */
    create: async (scope: Scope, project: Project) => {
      const state = this.#for(scope);
      state.projects.set(project.id, project);

      const policy: GuardrailPolicy = {
        id: newId(),
        projectId: project.id,
        name: DEFAULT_GUARDRAIL_POLICY_NAME,
        version: 1,
        isProjectDefault: true,
        checks: defaultGuardrailChecks(newId),
        createdAt: project.createdAt,
        updatedAt: project.createdAt,
      };
      state.guardrailPolicies.set(`${policy.id}:${policy.version}`, policy);

      return project;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).projects.get(id) ?? null,
    list: async (scope: Scope, query: CursorQuery) =>
      page([...this.#for(scope).projects.values()], query, (p) => p.id),
    update: async (
      scope: Scope,
      id: Id,
      patch: {
        name?: string;
        lastOpenedAt?: Timestamp;
        paused?: boolean;
        buildCapacity?: number;
        checkCommands?: CheckCommand[];
        setupCommand?: string | null;
        previewCommand?: string | null;
        previewUrl?: string | null;
        updatedAt: Timestamp;
      },
    ) => {
      const current = this.#for(scope).projects.get(id);
      if (current === undefined) return null;
      const next: Project = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.lastOpenedAt === undefined ? {} : { lastOpenedAt: patch.lastOpenedAt }),
        ...(patch.paused === undefined ? {} : { paused: patch.paused }),
        ...(patch.buildCapacity === undefined ? {} : { buildCapacity: patch.buildCapacity }),
        ...(patch.checkCommands === undefined ? {} : { checkCommands: patch.checkCommands }),
        updatedAt: patch.updatedAt,
      };
      // ACE parity P0: `null` clears the setup command, `undefined` leaves it (D72).
      if (patch.setupCommand === null) delete next.setupCommand;
      else if (patch.setupCommand !== undefined) next.setupCommand = patch.setupCommand;
      if (patch.previewCommand === null) delete next.previewCommand;
      else if (patch.previewCommand !== undefined) next.previewCommand = patch.previewCommand;
      if (patch.previewUrl === null) delete next.previewUrl;
      else if (patch.previewUrl !== undefined) next.previewUrl = patch.previewUrl;
      this.#for(scope).projects.set(id, next);
      return next;
    },
    delete: async (scope: Scope, id: Id) => this.#for(scope).projects.delete(id),
  };

  readonly workflows = {
    create: async (scope: Scope, workflow: Workflow) => {
      this.#for(scope).workflows.set(workflow.id, workflow);
      return workflow;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).workflows.get(id) ?? null,
    listByProject: async (scope: Scope, projectId: Id, query: CursorQuery) =>
      page(
        [...this.#for(scope).workflows.values()].filter((w) => w.projectId === projectId),
        query,
        (w) => w.id,
      ),
    update: async (
      scope: Scope,
      id: Id,
      patch: { name?: string; version?: number; updatedAt: Timestamp },
    ) => {
      const current = this.#for(scope).workflows.get(id);
      if (current === undefined) return null;
      const next: Workflow = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.version === undefined ? {} : { version: patch.version }),
        updatedAt: patch.updatedAt,
      };
      this.#for(scope).workflows.set(id, next);
      return next;
    },
    delete: async (scope: Scope, id: Id) => this.#for(scope).workflows.delete(id),
  };

  readonly nodes = {
    listByProvider: async (scope: Scope, providerId: Id) =>
      [...this.#for(scope).nodes.values()].filter(
        (node) => 'providerId' in node.config && node.config.providerId === providerId,
      ),
    listByKnowledgeBase: async (scope: Scope, knowledgeBaseId: Id) =>
      [...this.#for(scope).nodes.values()].filter((node) =>
        namesKnowledgeBase(node, knowledgeBaseId),
      ),
    listByWorkflow: async (scope: Scope, workflowId: Id) =>
      [...this.#for(scope).nodes.values()]
        .filter((n) => n.workflowId === workflowId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    getById: async (scope: Scope, nodeId: Id) => {
      const state = this.#for(scope);
      const node = state.nodes.get(nodeId);
      if (node === undefined) return null;
      const workflow = state.workflows.get(node.workflowId);
      if (workflow === undefined) return null;
      return { node, workflowId: node.workflowId, projectId: workflow.projectId };
    },
    insert: async (scope: Scope, node: Node) => {
      this.#for(scope).nodes.set(node.id, node);
    },
    update: async (scope: Scope, node: Node) => {
      this.#for(scope).nodes.set(node.id, node);
    },
    delete: async (scope: Scope, id: Id) => {
      this.#for(scope).nodes.delete(id);
    },
    deleteByWorkflow: async (scope: Scope, workflowId: Id) => {
      const state = this.#for(scope);
      for (const [id, node] of state.nodes) {
        if (node.workflowId === workflowId) state.nodes.delete(id);
      }
    },
  };

  readonly edges = {
    listByWorkflow: async (scope: Scope, workflowId: Id) =>
      [...this.#for(scope).edges.values()]
        .filter((e) => e.workflowId === workflowId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    insert: async (scope: Scope, edge: Edge) => {
      this.#for(scope).edges.set(edge.id, edge);
    },
    update: async (scope: Scope, edge: Edge) => {
      this.#for(scope).edges.set(edge.id, edge);
    },
    delete: async (scope: Scope, id: Id) => {
      this.#for(scope).edges.delete(id);
    },
    deleteByWorkflow: async (scope: Scope, workflowId: Id) => {
      const state = this.#for(scope);
      for (const [id, edge] of state.edges) {
        if (edge.workflowId === workflowId) state.edges.delete(id);
      }
    },
    deleteByNode: async (scope: Scope, nodeId: Id) => {
      const state = this.#for(scope);
      for (const [id, edge] of state.edges) {
        if (edge.from.nodeId === nodeId || edge.to.nodeId === nodeId) state.edges.delete(id);
      }
    },
  };

  readonly events = {
    append: async (scope: Scope, event: NewEngineEvent) => {
      const state = this.#for(scope);
      const stored: EngineEvent = { ...event, seq: state.nextSeq };
      state.nextSeq += 1;
      state.events.push(stored);
      return stored;
    },
    listAfter: async (scope: Scope, afterSeq: number, filter: EventFilter) =>
      this.#for(scope)
        .events.filter((event) => {
          if (event.seq <= afterSeq) return false;
          if (filter.runIds !== undefined) {
            return event.runId !== undefined && filter.runIds.includes(event.runId);
          }
          // A thread frame routes by threadId and never by workflow or engine scope (§2.5).
          if ((THREAD_EVENT_TYPES as readonly string[]).includes(event.type)) {
            const threadId = (event.payload as { threadId?: Id }).threadId;
            return threadId !== undefined && (filter.threadIds?.includes(threadId) ?? false);
          }
          if (event.workflowId === undefined) return filter.includeEngineScope === true;
          return filter.workflowIds?.includes(event.workflowId) ?? false;
        })
        .sort((a, b) => a.seq - b.seq),
    currentSeq: async (scope: Scope) => {
      const { events } = this.#for(scope);
      return events.length === 0 ? 0 : Math.max(...events.map((e) => e.seq));
    },
  };

  readonly settings = {
    get: async (scope: Scope) =>
      this.#for(scope).settings ?? SettingsSchema.parse({ dataDir: '/tmp/ace' }),
    update: async (scope: Scope, patch: SettingsPatch) => {
      const state = this.#for(scope);
      const current = state.settings ?? SettingsSchema.parse({ dataDir: '/tmp/ace' });
      const next = SettingsSchema.parse({ ...current, ...patch });
      state.settings = next;
      return next;
    },
  };

  /* ------------------------------------------------- round 2 (Arch §15.3) */

  readonly providers = {
    create: async (scope: Scope, provider: Provider) => {
      this.#for(scope).providers.set(provider.id, provider);
      return provider;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).providers.get(id) ?? null,
    list: async (scope: Scope) =>
      [...this.#for(scope).providers.values()].sort((a, b) => a.id.localeCompare(b.id)),
    update: async (scope: Scope, id: Id, patch: ProviderPatch) => {
      const current = this.#for(scope).providers.get(id);
      if (current === undefined) return null;

      const next: Provider = { ...current };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.baseUrl !== undefined) {
        if (patch.baseUrl === null) delete next.baseUrl;
        else next.baseUrl = patch.baseUrl;
      }
      if (patch.keySet !== undefined) next.keySet = patch.keySet;
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.statusMessage !== undefined) {
        if (patch.statusMessage === null) delete next.statusMessage;
        else next.statusMessage = patch.statusMessage;
      }
      if (patch.lastCheckedAt !== undefined) next.lastCheckedAt = patch.lastCheckedAt;
      if (patch.concurrency !== undefined) next.concurrency = patch.concurrency;
      if (patch.cliPermission !== undefined) {
        if (patch.cliPermission === null) delete next.cliPermission;
        else next.cliPermission = patch.cliPermission;
      }
      if (patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt;

      this.#for(scope).providers.set(id, next);
      return next;
    },
    delete: async (scope: Scope, id: Id) => this.#for(scope).providers.delete(id),
  };

  readonly models = {
    replaceForProvider: async (scope: Scope, providerId: Id, catalog: readonly Model[]) => {
      const state = this.#for(scope);
      for (const [key, model] of state.models) {
        if (model.providerId === providerId) state.models.delete(key);
      }
      for (const model of catalog) state.models.set(model.id, model);
    },
    list: async (scope: Scope, query: ModelQuery) =>
      [...this.#for(scope).models.values()]
        .filter((model) => modelMatchesQuery(model, query))
        .sort((a, b) => a.id.localeCompare(b.id)),
    find: async (scope: Scope, providerId: Id, modelId: string) =>
      [...this.#for(scope).models.values()].find(
        (model) => model.providerId === providerId && model.modelId === modelId,
      ) ?? null,
    deleteForProvider: async (scope: Scope, providerId: Id) => {
      const state = this.#for(scope);
      for (const [key, model] of state.models) {
        if (model.providerId === providerId) state.models.delete(key);
      }
    },
  };

  readonly priceTables = {
    put: async (scope: Scope, table: PriceTable) => {
      const state = this.#for(scope);
      if (!state.priceTables.has(table.version)) state.priceTables.set(table.version, table);
    },
    get: async (scope: Scope, version: string) => this.#for(scope).priceTables.get(version) ?? null,
    list: async (scope: Scope) =>
      [...this.#for(scope).priceTables.values()].sort((a, b) => a.version.localeCompare(b.version)),
  };

  readonly runs = {
    create: async (scope: Scope, run: Run) => {
      this.#for(scope).runs.set(run.id, run);
      return run;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).runs.get(id) ?? null,
    listByWorkflow: async (
      scope: Scope,
      workflowId: Id,
      query: CursorQuery,
    ): Promise<Page<Run>> => {
      const ordered = [...this.#for(scope).runs.values()]
        .filter((run) => run.workflowId === workflowId)
        .sort((a, b) => b.id.localeCompare(a.id));
      const start =
        query.cursor === undefined ? 0 : ordered.findIndex((run) => run.id < query.cursor!);
      const window = ordered.slice(start === -1 ? ordered.length : start, undefined);
      const items = window.slice(0, query.limit);
      const nextCursor = window.length > query.limit ? items.at(-1)?.id : undefined;
      return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
    listActive: async (scope: Scope) =>
      [...this.#for(scope).runs.values()]
        .filter(
          (run) =>
            run.status === 'PREFLIGHT' || run.status === 'RUNNING' || run.status === 'PAUSED',
        )
        .sort((a, b) => a.id.localeCompare(b.id)),
    update: async (scope: Scope, id: Id, patch: RunPatch) => {
      const current = this.#for(scope).runs.get(id);
      if (current === undefined) return null;

      const next: Run = { ...current };
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.haltReason !== undefined) next.haltReason = patch.haltReason;
      if (patch.preflightIssues !== undefined) next.preflightIssues = patch.preflightIssues;
      if (patch.totals !== undefined) next.totals = patch.totals;
      if (patch.endedAt !== undefined) next.endedAt = patch.endedAt;
      if (patch.durationMs !== undefined) next.durationMs = patch.durationMs;
      if (patch.finalOutput !== undefined) next.finalOutput = patch.finalOutput;
      // Round 3 (§2.1, §2.3). `pausedAt: null` removes the timestamp, the way the SQLite store
      // writes NULL into the column on a resume (D106, following D72); `undefined` leaves it alone.
      if (patch.pausedAt === null) delete next.pausedAt;
      else if (patch.pausedAt !== undefined) next.pausedAt = patch.pausedAt;
      if (patch.allowedActions !== undefined) next.allowedActions = patch.allowedActions;
      if (patch.budgetHalt !== undefined) next.budgetHalt = patch.budgetHalt;
      if (patch.restartedFromRunId !== undefined) {
        next.restartedFromRunId = patch.restartedFromRunId;
      }

      this.#for(scope).runs.set(id, next);
      return next;
    },
  };

  readonly nodeRuns = {
    create: async (scope: Scope, nodeRun: NodeRun) => {
      this.#for(scope).nodeRuns.set(nodeRun.id, nodeRun);
      return nodeRun;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).nodeRuns.get(id) ?? null,
    listByRun: async (scope: Scope, runId: Id) =>
      [...this.#for(scope).nodeRuns.values()]
        .filter((nodeRun) => nodeRun.runId === runId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    update: async (scope: Scope, id: Id, patch: NodeRunPatch) => {
      const current = this.#for(scope).nodeRuns.get(id);
      if (current === undefined) return null;

      const next: NodeRun = { ...current };
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.failureReason !== undefined) next.failureReason = patch.failureReason;
      if (patch.error !== undefined) next.error = patch.error;
      if (patch.modelUsed !== undefined) next.modelUsed = patch.modelUsed;
      if (patch.output !== undefined) next.output = patch.output;
      if (patch.prompt !== undefined) next.prompt = patch.prompt;
      if (patch.usage !== undefined) next.usage = patch.usage;
      if (patch.guardrailPolicy !== undefined) next.guardrailPolicy = patch.guardrailPolicy;
      if (patch.loopStop !== undefined) next.loopStop = patch.loopStop;
      if (patch.reusedFromNodeRunId !== undefined) {
        next.reusedFromNodeRunId = patch.reusedFromNodeRunId;
      }
      if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
      if (patch.endedAt !== undefined) next.endedAt = patch.endedAt;
      if (patch.durationMs !== undefined) next.durationMs = patch.durationMs;
      if (patch.sources !== undefined) next.sources = patch.sources;
      if (patch.droppedSources !== undefined) next.droppedSources = patch.droppedSources;
      if (patch.memoryOps !== undefined) next.memoryOps = patch.memoryOps;
      if (patch.inputEnvelopes !== undefined) next.inputEnvelopes = patch.inputEnvelopes;

      this.#for(scope).nodeRuns.set(id, next);
      return next;
    },
    /** The day's spend, the way SQLite sums it (round 3 §2.3): by `startedAt`'s calendar date. */
    dailyCostUsd: async (scope: Scope, day: string) =>
      [...this.#for(scope).nodeRuns.values()]
        .filter((nodeRun) => nodeRun.startedAt?.startsWith(day) === true)
        .reduce((total, nodeRun) => total + nodeRun.usage.costUsd, 0),
  };

  /* Round 3 (Arch §15.3). */

  /**
   * Keyed `${id}:${version}`, because the real table is: a PATCH inserts a version and never
   * rewrites the ones before it (FR-GRD-001, Arch §13.4). A fake that kept one row per policy would
   * pass every test here and still make `getVersion` a lie.
   */
  readonly guardrailPolicies = {
    create: async (scope: Scope, policy: GuardrailPolicy) => {
      this.#for(scope).guardrailPolicies.set(`${policy.id}:${policy.version}`, policy);
      return policy;
    },
    get: async (scope: Scope, id: Id) => this.#latestPolicy(scope, id),
    getVersion: async (scope: Scope, id: Id, version: number) =>
      this.#for(scope).guardrailPolicies.get(`${id}:${version}`) ?? null,
    listByProject: async (scope: Scope, projectId?: Id) => {
      const ids = new Set(
        [...this.#for(scope).guardrailPolicies.values()].map((policy) => policy.id),
      );
      return [...ids]
        .map((id) => this.#latestPolicy(scope, id))
        .filter((policy): policy is GuardrailPolicy => policy !== null)
        .filter((policy) => projectId === undefined || policy.projectId === projectId)
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    getProjectDefault: async (scope: Scope, projectId: Id) =>
      [...this.#for(scope).guardrailPolicies.values()].find(
        (policy) => policy.projectId === projectId && policy.isProjectDefault,
      ) ?? null,
    update: async (scope: Scope, id: Id, patch: GuardrailPolicyPatch) => {
      const policies = this.#for(scope).guardrailPolicies;
      const current = this.#latestPolicy(scope, id);
      if (current === null) return null;

      const next: GuardrailPolicy = { ...current };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.version !== undefined) next.version = patch.version;
      if (patch.checks !== undefined) next.checks = patch.checks;
      if (patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt;

      // A higher version is a new row; the flag travels with it, so only one row per project ever
      // carries `isProjectDefault` (the store's unique index).
      if (next.version > current.version && current.isProjectDefault) {
        policies.set(`${current.id}:${current.version}`, { ...current, isProjectDefault: false });
      }
      policies.set(`${next.id}:${next.version}`, next);
      return next;
    },
    setDefault: async (scope: Scope, id: Id) => {
      const policies = this.#for(scope).guardrailPolicies;
      const target = this.#latestPolicy(scope, id);
      if (target === null) return null;

      for (const [key, policy] of policies) {
        if (policy.projectId === target.projectId && policy.isProjectDefault) {
          policies.set(key, { ...policy, isProjectDefault: false });
        }
      }
      const next: GuardrailPolicy = { ...target, isProjectDefault: true };
      policies.set(`${next.id}:${next.version}`, next);
      return next;
    },
    delete: async (scope: Scope, id: Id) => {
      const policies = this.#for(scope).guardrailPolicies;
      let removed = false;
      for (const [key, policy] of [...policies]) {
        if (policy.id !== id) continue;
        policies.delete(key);
        removed = true;
      }
      return removed;
    },
    nodesUsing: async (scope: Scope, id: Id) =>
      [...this.#for(scope).nodes.values()].filter(
        (node) => 'guardrailPolicyId' in node.config && node.config.guardrailPolicyId === id,
      ),
  };

  readonly guardrailVerdicts = {
    /** Mirrors onto the node run, exactly as the SQLite adapter does (FR-GRD-015). */
    append: async (scope: Scope, verdict: Verdict) => {
      const state = this.#for(scope);
      state.guardrailVerdicts.push(verdict);

      const nodeRun = state.nodeRuns.get(verdict.nodeRunId);
      if (nodeRun !== undefined) {
        state.nodeRuns.set(nodeRun.id, { ...nodeRun, verdicts: [...nodeRun.verdicts, verdict] });
      }
      return verdict;
    },
    listByNodeRun: async (scope: Scope, nodeRunId: Id) =>
      this.#for(scope).guardrailVerdicts.filter((verdict) => verdict.nodeRunId === nodeRunId),
  };

  readonly approvals = {
    create: async (scope: Scope, request: ApprovalRequest) => {
      this.#for(scope).approvals.set(request.id, { request });
      return request;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).approvals.get(id) ?? null,
    findPendingByNodeRun: async (scope: Scope, nodeRunId: Id) =>
      [...this.#for(scope).approvals.values()].find(
        (stored) => stored.request.nodeRunId === nodeRunId && stored.decision === undefined,
      )?.request ?? null,
    listPendingByRun: async (scope: Scope, runId: Id) =>
      [...this.#for(scope).approvals.values()]
        .filter((stored) => stored.request.runId === runId && stored.decision === undefined)
        .map((stored) => stored.request)
        .sort((a, b) => a.id.localeCompare(b.id)),
    decide: async (scope: Scope, decision: ApprovalDecision) => {
      const state = this.#for(scope);
      const stored = state.approvals.get(decision.requestId);
      if (stored === undefined) return null;
      if (stored.decision !== undefined) return stored;

      const next: StoredApproval = { request: stored.request, decision };
      state.approvals.set(decision.requestId, next);

      const nodeRun = state.nodeRuns.get(stored.request.nodeRunId);
      if (nodeRun !== undefined) {
        state.nodeRuns.set(nodeRun.id, {
          ...nodeRun,
          approvals: [...(nodeRun.approvals ?? []), decision],
        });
      }
      return next;
    },
  };

  /* ------------------------------------------------- round 4 (Arch §15.3) */

  readonly artifacts = {
    create: async (scope: Scope, artifact: Artifact) => {
      this.#for(scope).artifacts.set(artifact.id, artifact);
      return artifact;
    },
    getById: async (scope: Scope, id: Id) => this.#for(scope).artifacts.get(id) ?? null,
    /** The dedupe lookup (FR-MM-002): the stored row with these exact bytes, or null. */
    getByHash: async (scope: Scope, hash: string) =>
      [...this.#for(scope).artifacts.values()].find((artifact) => artifact.hash === hash) ?? null,
    /** Newest first, cursor-exclusive on the id, as the SQLite adapter pages it (ULIDs are monotonic). */
    list: async (scope: Scope, query: CursorQuery): Promise<Page<Artifact>> => {
      const ordered = [...this.#for(scope).artifacts.values()].sort((a, b) =>
        b.id.localeCompare(a.id),
      );
      const from = query.cursor === undefined ? 0 : ordered.findIndex((a) => a.id < query.cursor!);
      const window = ordered.slice(from === -1 ? ordered.length : from);
      const items = window.slice(0, query.limit);
      const nextCursor = window.length > query.limit ? items.at(-1)?.id : undefined;
      return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
    touch: async (scope: Scope, id: Id, at: Timestamp) => {
      const current = this.#for(scope).artifacts.get(id);
      if (current === undefined) return null;
      const next: Artifact = { ...current, lastReferencedAt: at };
      this.#for(scope).artifacts.set(id, next);
      return next;
    },
    /**
     * Arch §15.4's sweep candidates: the reference time (`lastReferencedAt`, or `createdAt` when it
     * was never referenced) is before `before` and nothing live points at the id. The SQLite adapter
     * asks this with four `NOT EXISTS` substring clauses over `nodes.config`, a node run's `output`
     * and `inputEnvelopes`, a timeline message's `content` and a chat message's `content`; the fake
     * mirrors it by matching the same quoted-id substring against the JSON of those same places.
     * Both also keep a knowledge-base document's `artifactId`, an exact match (round 5).
     */
    unreferencedBefore: async (scope: Scope, before: Timestamp) => {
      const state = this.#for(scope);
      const isReferenced = (id: Id): boolean => {
        const needle = `"${id}"`;
        for (const node of state.nodes.values()) {
          if (JSON.stringify(node.config).includes(needle)) return true;
        }
        for (const nodeRun of state.nodeRuns.values()) {
          if (JSON.stringify(nodeRun.output ?? []).includes(needle)) return true;
          if (JSON.stringify(nodeRun.inputEnvelopes).includes(needle)) return true;
        }
        for (const message of state.messages.values()) {
          if (JSON.stringify(message.content).includes(needle)) return true;
        }
        for (const chatMessage of state.chatMessages.values()) {
          if (JSON.stringify(chatMessage.content).includes(needle)) return true;
        }
        // A knowledge-base document's source file, an exact match as SQLite's (final-review C1).
        for (const doc of state.kbDocuments.values()) {
          if (doc.artifactId === id) return true;
        }
        return false;
      };
      return [...state.artifacts.values()]
        .filter((artifact) => (artifact.lastReferencedAt ?? artifact.createdAt) < before)
        .filter((artifact) => !isReferenced(artifact.id))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    delete: async (scope: Scope, id: Id) => this.#for(scope).artifacts.delete(id),
  };

  readonly toolCalls = {
    /**
     * Appends the logged call and mirrors it onto its node run's `toolCalls` list in one
     * transaction, the way the SQLite adapter does (FR-TOOL-009) — the denormalised copy the
     * `NodeRun` contract carries cannot drift.
     */
    append: async (scope: Scope, runId: Id, call: ToolCall) =>
      this.transaction(async () => {
        const state = this.#for(scope);
        state.toolCalls.push({ runId, call });

        const nodeRun = state.nodeRuns.get(call.nodeRunId);
        if (nodeRun !== undefined) {
          state.nodeRuns.set(nodeRun.id, { ...nodeRun, toolCalls: [...nodeRun.toolCalls, call] });
        }
        return call;
      }),
    listByNodeRun: async (scope: Scope, nodeRunId: Id) =>
      this.#for(scope)
        .toolCalls.filter((entry) => entry.call.nodeRunId === nodeRunId)
        .map((entry) => entry.call)
        .sort((a, b) => a.id.localeCompare(b.id)),
    listByRun: async (scope: Scope, runId: Id) =>
      this.#for(scope)
        .toolCalls.filter((entry) => entry.runId === runId)
        .map((entry) => entry.call)
        .sort((a, b) => a.id.localeCompare(b.id)),
  };

  readonly mcpServers = {
    create: async (scope: Scope, server: McpServer) => {
      this.#for(scope).mcpServers.set(server.id, server);
      return server;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).mcpServers.get(id) ?? null,
    /** Oldest first — the order they were added. */
    list: async (scope: Scope) =>
      [...this.#for(scope).mcpServers.values()].sort((a, b) => a.id.localeCompare(b.id)),
    updateStatus: async (scope: Scope, id: Id, patch: McpServerPatch) => {
      const current = this.#for(scope).mcpServers.get(id);
      if (current === undefined) return null;

      const next: McpServer = { ...current };
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.toolCount !== undefined) next.toolCount = patch.toolCount;
      if (patch.lastCheckedAt !== undefined) next.lastCheckedAt = patch.lastCheckedAt;
      // `null` clears the error on a reconnect, `undefined` leaves it alone (D72's convention).
      if (patch.error === null) delete next.error;
      else if (patch.error !== undefined) next.error = patch.error;

      this.#for(scope).mcpServers.set(id, next);
      return next;
    },
    delete: async (scope: Scope, id: Id) => this.#for(scope).mcpServers.delete(id),
  };

  readonly messages = {
    /** Append-only, like the SQLite timeline: never updates. */
    append: async (scope: Scope, message: Message) => {
      this.#for(scope).messages.set(message.id, message);
      return message;
    },
    /**
     * `GET /workflows/:id/messages` (FR-CHAT-002): filters combine, oldest first, cursor-paged.
     * `messageMatchesQuery` decides runId/nodeId/type just as the engine and UI do (D52); the cursor
     * is exclusive on the id, and the workflow scopes it.
     */
    query: async (scope: Scope, workflowId: Id, query: MessageQuery): Promise<Page<Message>> => {
      const limit = query.limit ?? 100;
      const ordered = [...this.#for(scope).messages.values()]
        .filter((message) => message.workflowId === workflowId)
        .filter((message) => query.runId === undefined || message.runId === query.runId)
        .filter((message) => query.nodeId === undefined || message.nodeId === query.nodeId)
        .filter(
          (message) =>
            query.type === undefined ||
            query.type.length === 0 ||
            query.type.includes(message.type),
        )
        .filter((message) => query.cursor === undefined || message.id > query.cursor)
        .sort((a, b) => a.id.localeCompare(b.id));

      const items = ordered.slice(0, limit);
      const nextCursor = ordered.length > limit ? items.at(-1)?.id : undefined;
      return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },
  };

  readonly chatThreads = {
    create: async (scope: Scope, thread: ChatThread) => {
      this.#for(scope).chatThreads.set(thread.id, thread);
      return thread;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).chatThreads.get(id) ?? null,
    /** The agent's threads, oldest first. */
    listByNode: async (scope: Scope, nodeId: Id) =>
      [...this.#for(scope).chatThreads.values()]
        .filter((thread) => thread.nodeId === nodeId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    touch: async (scope: Scope, id: Id, updatedAt: Timestamp) => {
      const current = this.#for(scope).chatThreads.get(id);
      if (current === undefined) return null;
      const next: ChatThread = { ...current, updatedAt };
      this.#for(scope).chatThreads.set(id, next);
      return next;
    },
    /** The thread and its messages go together, in one transaction (Arch §15.4). */
    delete: async (scope: Scope, id: Id) =>
      this.transaction(async () => {
        const state = this.#for(scope);
        if (!state.chatThreads.delete(id)) return false;
        for (const [messageId, message] of [...state.chatMessages]) {
          if (message.threadId === id) state.chatMessages.delete(messageId);
        }
        return true;
      }),
  };

  readonly chatMessages = {
    append: async (scope: Scope, message: ChatMessage) => {
      this.#for(scope).chatMessages.set(message.id, message);
      return message;
    },
    /** In the order they were sent — the order the conversation happened. */
    listByThread: async (scope: Scope, threadId: Id) =>
      [...this.#for(scope).chatMessages.values()]
        .filter((message) => message.threadId === threadId)
        .sort((a, b) => a.id.localeCompare(b.id)),
  };

  /* Round 5 (Arch §15.3, §21.3). */

  /**
   * A base as read: `documentCount` and `chunkCount` derived from this fake's own rows — every
   * document whatever its status, every chunk — as the SQLite adapter derives them, rather than
   * whatever count was last patched in.
   */
  #counted(state: State, kb: KnowledgeBase): KnowledgeBase {
    let documentCount = 0;
    for (const doc of state.kbDocuments.values()) {
      if (doc.knowledgeBaseId === kb.id) documentCount += 1;
    }
    let chunkCount = 0;
    for (const row of state.kbChunks.values()) {
      if (row.chunk.knowledgeBaseId === kb.id) chunkCount += 1;
    }
    return { ...kb, documentCount, chunkCount };
  }

  readonly knowledgeBases: KnowledgeBaseRepository = {
    insert: async (scope, kb) => {
      const state = this.#for(scope);
      state.knowledgeBases.set(kb.id, kb);
      return this.#counted(state, kb);
    },
    get: async (scope, id) => {
      const state = this.#for(scope);
      const kb = state.knowledgeBases.get(id);
      return kb === undefined ? null : this.#counted(state, kb);
    },
    listByEmbeddingProvider: async (scope, providerId) => {
      const state = this.#for(scope);
      return [...state.knowledgeBases.values()]
        .filter((kb) => kb.embeddingProviderId === providerId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((kb) => this.#counted(state, kb));
    },
    listByProject: async (scope, projectId) => {
      const state = this.#for(scope);
      return [...state.knowledgeBases.values()]
        .filter((kb) => kb.projectId === projectId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((kb) => this.#counted(state, kb));
    },
    update: async (scope, id, patch) => {
      const state = this.#for(scope);
      const current = state.knowledgeBases.get(id);
      if (current === undefined) return null;
      const next: KnowledgeBase = { ...current, ...patch };
      state.knowledgeBases.set(id, next);
      return this.#counted(state, next);
    },
    /** Cascades documents and their chunks, vectors and index rows, as the real adapter does. */
    delete: async (scope, id) => {
      const state = this.#for(scope);
      state.knowledgeBases.delete(id);
      for (const [docId, doc] of [...state.kbDocuments]) {
        if (doc.knowledgeBaseId === id) state.kbDocuments.delete(docId);
      }
      for (const [chunkId, row] of [...state.kbChunks]) {
        if (row.chunk.knowledgeBaseId === id) state.kbChunks.delete(chunkId);
      }
    },
  };

  readonly kbDocuments: KbDocumentRepository = {
    insert: async (scope, doc) => {
      this.#for(scope).kbDocuments.set(doc.id, doc);
      return doc;
    },
    get: async (scope, id) => this.#for(scope).kbDocuments.get(id) ?? null,
    listByKnowledgeBase: async (scope, knowledgeBaseId) =>
      [...this.#for(scope).kbDocuments.values()]
        .filter((doc) => doc.knowledgeBaseId === knowledgeBaseId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    listUnsettled: async (scope) =>
      [...this.#for(scope).kbDocuments.values()]
        .filter((doc) => doc.status !== 'ready' && doc.status !== 'failed')
        .sort((a, b) => a.id.localeCompare(b.id)),
    update: async (scope, id, patch) => {
      const state = this.#for(scope);
      const current = state.kbDocuments.get(id);
      if (current === undefined) return null;
      const next: KbDocument = { ...current };
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.chunkCount !== undefined) next.chunkCount = patch.chunkCount;
      if (patch.error === null) delete next.error;
      else if (patch.error !== undefined) next.error = patch.error;
      if (patch.ingestedAt !== undefined) next.ingestedAt = patch.ingestedAt;
      if (patch.verdicts !== undefined) next.verdicts = patch.verdicts;
      state.kbDocuments.set(id, next);
      return next;
    },
    delete: async (scope, id) => {
      const state = this.#for(scope);
      state.kbDocuments.delete(id);
      for (const [chunkId, row] of [...state.kbChunks]) {
        if (row.chunk.documentId === id) state.kbChunks.delete(chunkId);
      }
    },
  };

  readonly kbChunks: KbChunkRepository = {
    replaceForDocument: async (scope, documentId, chunks, embeddings) => {
      if (chunks.length !== embeddings.length) {
        throw new Error('replaceForDocument needs one embedding per chunk');
      }
      const state = this.#for(scope);
      for (const [chunkId, row] of [...state.kbChunks]) {
        if (row.chunk.documentId === documentId) state.kbChunks.delete(chunkId);
      }
      chunks.forEach((chunk, index) => {
        state.kbChunks.set(chunk.id, { chunk, embedding: embeddings[index]! });
      });
    },
    getMany: async (scope, ids) => {
      const state = this.#for(scope);
      return ids.flatMap((id) => {
        const row = state.kbChunks.get(id);
        return row === undefined ? [] : [row.chunk];
      });
    },
    countByKnowledgeBase: async (scope, knowledgeBaseId) =>
      [...this.#for(scope).kbChunks.values()].filter(
        (row) => row.chunk.knowledgeBaseId === knowledgeBaseId,
      ).length,
  };

  readonly memory: MemoryRepository = {
    list: async (scope, nodeId) =>
      [...this.#for(scope).memory.values()]
        .filter((entry) => entry.nodeId === nodeId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    upsert: async (scope, nodeId, key, value, at, newId) => {
      const state = this.#for(scope);
      const existing = [...state.memory.values()].find(
        (entry) => entry.nodeId === nodeId && entry.key === key,
      );
      const next: MemoryEntry =
        existing === undefined
          ? { id: newId(), nodeId, key, value, createdAt: at, updatedAt: at }
          : { ...existing, value, updatedAt: at };
      state.memory.set(next.id, next);
      return next;
    },
    deleteKey: async (scope, nodeId, key) => {
      const state = this.#for(scope);
      const existing = [...state.memory.values()].find(
        (entry) => entry.nodeId === nodeId && entry.key === key,
      );
      if (existing === undefined) return false;
      state.memory.delete(existing.id);
      return true;
    },
    deleteEntry: async (scope, nodeId, entryId) => {
      const state = this.#for(scope);
      const existing = state.memory.get(entryId);
      if (existing === undefined || existing.nodeId !== nodeId) return null;
      state.memory.delete(entryId);
      return existing;
    },
    clear: async (scope, nodeId) => {
      const state = this.#for(scope);
      const removed = [...state.memory.values()]
        .filter((entry) => entry.nodeId === nodeId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      for (const entry of removed) state.memory.delete(entry.id);
      return removed;
    },
    markUsed: async (scope, ids, at) => {
      const state = this.#for(scope);
      for (const id of ids) {
        const entry = state.memory.get(id);
        if (entry !== undefined) state.memory.set(id, { ...entry, lastUsedAt: at });
      }
    },
  };

  readonly summaryCache: SummaryCacheRepository = {
    get: async (scope, key, at) => {
      const state = this.#for(scope);
      const row = state.summaryCache.get(key);
      if (row === undefined) return null;
      // The 30 days count from creation; last use only orders the LRU prune.
      if (Date.parse(at) - Date.parse(row.createdAt) > SUMMARY_CACHE_TTL_MS) {
        state.summaryCache.delete(key);
        return null;
      }
      state.summaryCache.set(key, { ...row, lastUsedAt: at });
      return row.summary;
    },
    put: async (scope, key, summary, at) => {
      const state = this.#for(scope);
      state.summaryCache.delete(key);
      state.summaryCache.set(key, { summary, createdAt: at, lastUsedAt: at });
      if (state.summaryCache.size <= SUMMARY_CACHE_MAX_ROWS) return;
      const oldestFirst = [...state.summaryCache].sort((a, b) =>
        a[1].lastUsedAt.localeCompare(b[1].lastUsedAt),
      );
      for (const [staleKey] of oldestFirst.slice(
        0,
        state.summaryCache.size - SUMMARY_CACHE_MAX_ROWS,
      )) {
        state.summaryCache.delete(staleKey);
      }
    },
  };

  /** Folds this fake's node runs with D234's semantics, so a route test reads the same numbers SQLite gives. */
  readonly usage: UsageRepository = {
    aggregate: async (scope, query: UsageQuery): Promise<UsageResponse> => {
      const state = this.#for(scope);
      const groupBy = query.groupBy;
      const from = query.from === undefined ? undefined : Date.parse(query.from);
      const to = query.to === undefined ? undefined : Date.parse(query.to);

      const groups = new Map<
        string,
        { key: Record<string, string>; usage: Usage; runs: Set<string> }
      >();
      for (const nodeRun of state.nodeRuns.values()) {
        // Only node runs that called a model, with a recorded start, are counted (D234).
        if (nodeRun.modelUsed === undefined || nodeRun.startedAt === undefined) continue;
        const startedAt = Date.parse(nodeRun.startedAt);
        if (from !== undefined && startedAt < from) continue;
        if (to !== undefined && startedAt >= to) continue;

        const values: Record<string, string> = {
          provider: nodeRun.modelUsed.providerId,
          model: nodeRun.modelUsed.modelId,
          day: nodeRun.startedAt.slice(0, 10),
          workflow: state.runs.get(nodeRun.runId)?.workflowId ?? '',
        };
        const key: Record<string, string> = {};
        for (const by of groupBy) key[by] = values[by]!;

        const id = JSON.stringify(groupBy.map((by) => key[by]));
        const group = groups.get(id) ?? { key, usage: emptyUsage(), runs: new Set<string>() };
        group.usage = {
          tokensIn: group.usage.tokensIn + nodeRun.usage.tokensIn,
          tokensOut: group.usage.tokensOut + nodeRun.usage.tokensOut,
          costUsd: group.usage.costUsd + nodeRun.usage.costUsd,
        };
        group.runs.add(nodeRun.runId);
        groups.set(id, group);
      }

      const buckets: UsageBucket[] = [...groups.values()]
        .sort((a, b) => {
          for (const by of groupBy) {
            const left = a.key[by]!;
            const right = b.key[by]!;
            // Binary comparison, as SQLite's default collation orders text.
            if (left !== right) return left < right ? -1 : 1;
          }
          return 0;
        })
        .map((group) => ({ key: group.key, ...group.usage, runs: group.runs.size }));

      const totals = buckets.reduce<Usage>(
        (sum, bucket) => ({
          tokensIn: sum.tokensIn + bucket.tokensIn,
          tokensOut: sum.tokensOut + bucket.tokensOut,
          costUsd: sum.costUsd + bucket.costUsd,
        }),
        emptyUsage(),
      );
      return { buckets, totals };
    },
    dayTotals: async (scope, day) =>
      [...this.#for(scope).nodeRuns.values()]
        .filter(
          (nodeRun) =>
            nodeRun.modelUsed !== undefined && nodeRun.startedAt?.startsWith(day) === true,
        )
        .reduce<Usage>(
          (sum, nodeRun) => ({
            tokensIn: sum.tokensIn + nodeRun.usage.tokensIn,
            tokensOut: sum.tokensOut + nodeRun.usage.tokensOut,
            costUsd: sum.costUsd + nodeRun.usage.costUsd,
          }),
          emptyUsage(),
        ),
    healthCounts: async (scope): Promise<HealthMetrics> => {
      const state = this.#for(scope);
      const runs = [...state.runs.values()];
      const nodeRuns = [...state.nodeRuns.values()];

      const nodeFailuresByKind = Object.fromEntries(ERROR_KINDS.map((kind) => [kind, 0])) as Record<
        ErrorKind,
        number
      >;
      // Only a node that FAILED is a failure: a BLOCKED node carries an error too, but it did not
      // fail (CLAUDE.md §7, BR-03). The SQLite fold applies the same rule.
      for (const nodeRun of nodeRuns) {
        if (nodeRun.status !== NodeStateSchema.enum.FAILED || nodeRun.error === undefined) continue;
        nodeFailuresByKind[nodeRun.error.kind] += 1;
      }

      const durations = new Map<string, number[]>();
      for (const nodeRun of nodeRuns) {
        if (nodeRun.status !== 'COMPLETED') continue;
        if (nodeRun.modelUsed === undefined || nodeRun.durationMs === undefined) continue;
        const list = durations.get(nodeRun.modelUsed.providerId) ?? [];
        list.push(nodeRun.durationMs);
        durations.set(nodeRun.modelUsed.providerId, list);
      }
      const providerLatencyMs: HealthMetrics['providerLatencyMs'] = {};
      for (const [providerId, list] of durations) {
        const sorted = [...list].sort((a, b) => a - b);
        providerLatencyMs[providerId] = {
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
        };
      }

      const guardrailVerdictsByType: Record<string, number> = {};
      for (const verdict of state.guardrailVerdicts) {
        guardrailVerdictsByType[verdict.checkType] =
          (guardrailVerdictsByType[verdict.checkType] ?? 0) + 1;
      }

      const since =
        runs.map((run) => run.startedAt).sort((a, b) => a.localeCompare(b))[0] ??
        new Date().toISOString();

      return {
        runs: {
          started: runs.length,
          completed: runs.filter((run) => run.status === 'COMPLETE').length,
          halted: runs.filter((run) => run.status === 'HALTED').length,
          blocked: runs.filter((run) => run.status === 'BLOCKED').length,
        },
        nodeFailuresByKind,
        providerLatencyMs,
        guardrailVerdictsByType,
        since,
      };
    },
  };
}
