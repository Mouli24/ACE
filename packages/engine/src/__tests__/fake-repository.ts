import {
  DEFAULT_GUARDRAIL_POLICY_NAME,
  SettingsSchema,
  defaultGuardrailChecks,
  modelMatchesQuery,
  type ApprovalDecision,
  type ApprovalRequest,
  type CursorQuery,
  type Edge,
  type GuardrailPolicy,
  type Id,
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
  type Verdict,
  type Workflow,
} from '@ace/contracts';

import type {
  EngineEvent,
  EventFilter,
  GuardrailPolicyPatch,
  NewEngineEvent,
  NodeRunPatch,
  PriceTable,
  ProviderPatch,
  Repository,
  RunPatch,
  Scope,
  StoredApproval,
} from '../ports/index.js';
import { newId } from '../ids.js';

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
  };
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
      state.guardrailPolicies.set(policy.id, policy);

      return project;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).projects.get(id) ?? null,
    list: async (scope: Scope, query: CursorQuery) =>
      page([...this.#for(scope).projects.values()], query, (p) => p.id),
    update: async (
      scope: Scope,
      id: Id,
      patch: { name?: string; lastOpenedAt?: Timestamp; updatedAt: Timestamp },
    ) => {
      const current = this.#for(scope).projects.get(id);
      if (current === undefined) return null;
      const next: Project = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.lastOpenedAt === undefined ? {} : { lastOpenedAt: patch.lastOpenedAt }),
        updatedAt: patch.updatedAt,
      };
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
    listByWorkflow: async (scope: Scope, workflowId: Id) =>
      [...this.#for(scope).nodes.values()]
        .filter((n) => n.workflowId === workflowId)
        .sort((a, b) => a.id.localeCompare(b.id)),
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
    listByWorkflow: async (scope: Scope, workflowId: Id, query: CursorQuery): Promise<Page<Run>> => {
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
        .filter((run) => run.status === 'PREFLIGHT' || run.status === 'RUNNING' || run.status === 'PAUSED')
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

  readonly guardrailPolicies = {
    create: async (scope: Scope, policy: GuardrailPolicy) => {
      this.#for(scope).guardrailPolicies.set(policy.id, policy);
      return policy;
    },
    get: async (scope: Scope, id: Id) => this.#for(scope).guardrailPolicies.get(id) ?? null,
    listByProject: async (scope: Scope, projectId: Id) =>
      [...this.#for(scope).guardrailPolicies.values()]
        .filter((policy) => policy.projectId === projectId)
        .sort((a, b) => a.id.localeCompare(b.id)),
    getProjectDefault: async (scope: Scope, projectId: Id) =>
      [...this.#for(scope).guardrailPolicies.values()].find(
        (policy) => policy.projectId === projectId && policy.isProjectDefault,
      ) ?? null,
    update: async (scope: Scope, id: Id, patch: GuardrailPolicyPatch) => {
      const current = this.#for(scope).guardrailPolicies.get(id);
      if (current === undefined) return null;

      const next: GuardrailPolicy = { ...current };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.version !== undefined) next.version = patch.version;
      if (patch.checks !== undefined) next.checks = patch.checks;
      if (patch.updatedAt !== undefined) next.updatedAt = patch.updatedAt;

      this.#for(scope).guardrailPolicies.set(id, next);
      return next;
    },
    setDefault: async (scope: Scope, id: Id) => {
      const policies = this.#for(scope).guardrailPolicies;
      const target = policies.get(id);
      if (target === undefined) return null;

      for (const [key, policy] of policies) {
        if (policy.projectId === target.projectId && policy.isProjectDefault) {
          policies.set(key, { ...policy, isProjectDefault: false });
        }
      }
      const next: GuardrailPolicy = { ...target, isProjectDefault: true };
      policies.set(id, next);
      return next;
    },
    delete: async (scope: Scope, id: Id) => this.#for(scope).guardrailPolicies.delete(id),
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
}
