import {
  SettingsSchema,
  type CursorQuery,
  type Edge,
  type Id,
  type Node,
  type Page,
  type Project,
  type Settings,
  type SettingsPatch,
  type Timestamp,
  type Workflow,
} from '@ace/contracts';

import type {
  EngineEvent,
  EventFilter,
  NewEngineEvent,
  Repository,
  Scope,
} from '../ports/index.js';

interface State {
  projects: Map<string, Project>;
  workflows: Map<string, Workflow>;
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
  events: EngineEvent[];
  settings: Settings | null;
  nextSeq: number;
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
    create: async (scope: Scope, project: Project) => {
      this.#for(scope).projects.set(project.id, project);
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
}
