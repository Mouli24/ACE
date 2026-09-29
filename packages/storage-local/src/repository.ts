import {
  EdgeSchema,
  NodeSchema,
  SettingsSchema,
  THREAD_EVENT_TYPES,
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
  ApprovalRepository,
  ArtifactRepository,
  ChatMessageRepository,
  ChatThreadRepository,
  EdgeRepository,
  GuardrailPolicyRepository,
  GuardrailVerdictRepository,
  McpServerRepository,
  MessageRepository,
  ModelRepository,
  NodeRunRepository,
  PriceTableRepository,
  ProviderRepository,
  RunRepository,
  ToolCallRepository,
  EngineEvent,
  EventFilter,
  EventRepository,
  NewEngineEvent,
  NodeRepository,
  ProjectRepository,
  Repository,
  Scope,
  SettingsRepository,
  WorkflowRepository,
} from '@ace/engine';
import type BetterSqlite3 from 'better-sqlite3';
import { and, asc, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { buildDefaultPolicy } from './default-policy.js';
import {
  createApprovalRepository,
  createGuardrailPolicyRepository,
  createGuardrailVerdictRepository,
} from './repository-guardrails.js';
import {
  createArtifactRepository,
  createChatMessageRepository,
  createChatThreadRepository,
  createMcpServerRepository,
  createMessageRepository,
  createToolCallRepository,
} from './repository-round4.js';
import {
  createModelRepository,
  createNodeRunRepository,
  createPriceTableRepository,
  createProviderRepository,
  createRunRepository,
} from './repository-runs.js';
import type * as schema from './schema.js';
import { edges, events, nodes, projects, settings, workflows } from './schema.js';
import { toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Serialises transactions on the one local connection.
 *
 * `Repository` is async so the same interface can front Postgres later, but that means a
 * transaction body can await between statements. With a single SQLite connection an interleaved
 * writer would silently join the open transaction, so transactions queue instead.
 */
class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/* Row <-> domain                                                              */
/* -------------------------------------------------------------------------- */

type ProjectRow = typeof projects.$inferSelect;
type WorkflowRow = typeof workflows.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;
type EdgeRow = typeof edges.$inferSelect;
type EventRow = typeof events.$inferSelect;

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    folderPath: row.folderPath,
    ...(row.lastOpenedAt === null ? {} : { lastOpenedAt: row.lastOpenedAt }),
    // A cap that was never set and one that was removed read the same: no cap (D72).
    ...(row.maxCostPerRunUsd === null ? {} : { maxCostPerRunUsd: row.maxCostPerRunUsd }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    version: row.version,
    formatVersion: row.formatVersion as 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Parsed through the contract, so a row that drifted from §2.4 fails on read rather than later. */
function toNode(row: NodeRow): Node {
  return NodeSchema.parse({
    id: row.id,
    workflowId: row.workflowId,
    kind: row.kind,
    name: row.name,
    position: { x: row.positionX, y: row.positionY },
    inputs: JSON.parse(row.inputs),
    outputs: JSON.parse(row.outputs),
    config: JSON.parse(row.config),
  });
}

function toEdge(row: EdgeRow): Edge {
  return EdgeSchema.parse({
    id: row.id,
    workflowId: row.workflowId,
    kind: row.kind,
    from: { nodeId: row.fromNodeId, portId: row.fromPortId },
    to: { nodeId: row.toNodeId, portId: row.toPortId },
    ...(row.loop === null ? {} : { loop: JSON.parse(row.loop) }),
  });
}

function toEvent(row: EventRow): EngineEvent {
  return {
    seq: row.seq,
    type: row.type,
    ...(row.workflowId === null ? {} : { workflowId: row.workflowId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    payload: JSON.parse(row.payload),
    createdAt: row.createdAt,
  };
}

/**
 * Cursor pagination over a ULID primary key.
 *
 * This relies on ids coming from the engine's `newId()`, which is monotonic: plain `ulid()` gives
 * two ids minted in the same millisecond independent random tails, so they could sort either way
 * and a cursor could skip a row. With monotonic ids, ordering by `id` is creation order and the
 * cursor is simply the last id of the previous page.
 */
function paginate<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  return { items, nextCursor: cursorOf(items[items.length - 1]!) };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

export class SqliteRepository implements Repository {
  readonly #db: Db;
  readonly #sqlite: BetterSqlite3.Database;
  readonly #mutex = new Mutex();
  #depth = 0;

  /* Round 2 (Arch §15.3). Built in the constructor because they close over `#db`. */
  readonly providers: ProviderRepository;
  readonly models: ModelRepository;
  readonly priceTables: PriceTableRepository;
  readonly runs: RunRepository;
  readonly nodeRuns: NodeRunRepository;

  /* Round 3 (Arch §15.3). */
  readonly guardrailPolicies: GuardrailPolicyRepository;
  readonly guardrailVerdicts: GuardrailVerdictRepository;
  readonly approvals: ApprovalRepository;

  /* Round 4 (Arch §15.3). */
  readonly artifacts: ArtifactRepository;
  readonly toolCalls: ToolCallRepository;
  readonly mcpServers: McpServerRepository;
  readonly messages: MessageRepository;
  readonly chatThreads: ChatThreadRepository;
  readonly chatMessages: ChatMessageRepository;

  constructor(db: Db, sqlite: BetterSqlite3.Database) {
    this.#db = db;
    this.#sqlite = sqlite;

    this.providers = createProviderRepository(db);
    this.models = createModelRepository(db);
    this.priceTables = createPriceTableRepository(db);
    this.runs = createRunRepository(db);
    this.nodeRuns = createNodeRunRepository(db);

    // The round 3 repositories write two rows at once — a verdict and its node run's copy — so they
    // borrow this repository's transaction rather than opening one of their own, which also means
    // they join a transaction the caller already opened.
    const inTransaction = <T>(fn: () => Promise<T>): Promise<T> => this.transaction(() => fn());
    this.guardrailPolicies = createGuardrailPolicyRepository(db, inTransaction);
    this.guardrailVerdicts = createGuardrailVerdictRepository(db, inTransaction);
    this.approvals = createApprovalRepository(db, inTransaction);

    // Round 4. The tool-call log and a thread delete each write two rows at once — a call and its
    // node run's copy, a thread and its messages — so they borrow this repository's transaction.
    this.artifacts = createArtifactRepository(db);
    this.toolCalls = createToolCallRepository(db, inTransaction);
    this.mcpServers = createMcpServerRepository(db);
    this.messages = createMessageRepository(db);
    this.chatThreads = createChatThreadRepository(db, inTransaction);
    this.chatMessages = createChatMessageRepository(db);
  }

  /**
   * One transaction per call (NFR-REL-02, TC-NFR-006). A throw anywhere in the body rolls the whole
   * batch back, so a graph-ops batch is fully applied or not applied at all — never half written.
   * A nested call joins the transaction already open rather than starting a second one.
   */
  async transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T> {
    if (this.#depth > 0) return fn(this);

    return this.#mutex.runExclusive(async () => {
      this.#sqlite.exec('BEGIN IMMEDIATE');
      this.#depth += 1;
      try {
        const result = await fn(this);
        this.#sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        this.#sqlite.exec('ROLLBACK');
        throw error;
      } finally {
        this.#depth -= 1;
      }
    });
  }

  readonly projects: ProjectRepository = {
    /**
     * The project and its default guardrail policy, in one transaction (FR-GRD-018, D10).
     *
     * It happens here rather than in the project service because it is an invariant of the store:
     * every project has a default policy, including one created by an import, a template or a test.
     * The check list comes from `defaultGuardrailChecks` in `@ace/contracts`, the same definition
     * the migration's backfill uses, so a project created today and one backfilled yesterday get
     * byte-identical checks.
     */
    create: async (scope: Scope, project: Project) =>
      this.transaction(async () => {
        this.#db
          .insert(projects)
          .values({
            id: project.id,
            workspaceId: scope.workspaceId,
            name: project.name,
            folderPath: project.folderPath,
            lastOpenedAt: project.lastOpenedAt ?? null,
            maxCostPerRunUsd: project.maxCostPerRunUsd ?? null,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          })
          .run();

        await this.guardrailPolicies.create(
          scope,
          buildDefaultPolicy(project.id, project.createdAt),
        );

        return project;
      }),

    get: async (scope: Scope, id: Id) => {
      const row = this.#db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, id)))
        .get();
      return row === undefined ? null : toProject(row);
    },

    list: async (scope: Scope, page: CursorQuery) => {
      const rows = this.#db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, scope.workspaceId),
            page.cursor === undefined ? undefined : gt(projects.id, page.cursor),
          ),
        )
        .orderBy(asc(projects.id))
        .limit(page.limit + 1)
        .all();
      return paginate(rows.map(toProject), page.limit, (project) => project.id);
    },

    update: async (
      scope: Scope,
      id: Id,
      patch: {
        name?: string;
        lastOpenedAt?: Timestamp;
        maxCostPerRunUsd?: number | null;
        updatedAt: Timestamp;
      },
    ) => {
      this.#db
        .update(projects)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.lastOpenedAt === undefined ? {} : { lastOpenedAt: patch.lastOpenedAt }),
          // `null` removes the cap, `undefined` leaves whatever is stored alone (D72).
          ...(patch.maxCostPerRunUsd === undefined
            ? {}
            : { maxCostPerRunUsd: patch.maxCostPerRunUsd }),
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, id)))
        .run();
      return this.projects.get(scope, id);
    },

    delete: async (scope: Scope, id: Id) => {
      const result = this.#db
        .delete(projects)
        .where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, id)))
        .run();
      return result.changes > 0;
    },
  };

  readonly workflows: WorkflowRepository = {
    create: async (scope: Scope, workflow: Workflow) => {
      this.#db
        .insert(workflows)
        .values({ ...workflow, workspaceId: scope.workspaceId })
        .run();
      return workflow;
    },

    get: async (scope: Scope, id: Id) => {
      const row = this.#db
        .select()
        .from(workflows)
        .where(and(eq(workflows.workspaceId, scope.workspaceId), eq(workflows.id, id)))
        .get();
      return row === undefined ? null : toWorkflow(row);
    },

    listByProject: async (scope: Scope, projectId: Id, page: CursorQuery) => {
      const rows = this.#db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.workspaceId, scope.workspaceId),
            eq(workflows.projectId, projectId),
            page.cursor === undefined ? undefined : gt(workflows.id, page.cursor),
          ),
        )
        .orderBy(asc(workflows.id))
        .limit(page.limit + 1)
        .all();
      return paginate(rows.map(toWorkflow), page.limit, (workflow) => workflow.id);
    },

    update: async (
      scope: Scope,
      id: Id,
      patch: { name?: string; version?: number; updatedAt: Timestamp },
    ) => {
      this.#db
        .update(workflows)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.version === undefined ? {} : { version: patch.version }),
          updatedAt: patch.updatedAt,
        })
        .where(and(eq(workflows.workspaceId, scope.workspaceId), eq(workflows.id, id)))
        .run();
      return this.workflows.get(scope, id);
    },

    delete: async (scope: Scope, id: Id) => {
      const result = this.#db
        .delete(workflows)
        .where(and(eq(workflows.workspaceId, scope.workspaceId), eq(workflows.id, id)))
        .run();
      return result.changes > 0;
    },
  };

  readonly nodes: NodeRepository = {
    /**
     * `config` is a JSON column, so this is a substring match on the stored provider id. The
     * result is re-checked in TypeScript, because a LIKE could in principle match a provider id
     * that appears somewhere else in the config.
     */
    listByProvider: async (scope: Scope, providerId: Id) =>
      this.#db
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.workspaceId, scope.workspaceId),
            sql`${nodes.config} LIKE ${`%"${providerId}"%`}`,
          ),
        )
        .all()
        .map(toNode)
        .filter(
          (node) =>
            'providerId' in node.config && node.config.providerId === providerId,
        ),

    listByWorkflow: async (scope: Scope, workflowId: Id) => {
      const rows = this.#db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, scope.workspaceId), eq(nodes.workflowId, workflowId)))
        .orderBy(asc(nodes.id))
        .all();
      return rows.map(toNode);
    },

    getById: async (scope: Scope, nodeId: Id) => {
      // One join: the node, and the project id it reaches through its workflow (FR-CHAT-004).
      const row = this.#db
        .select({ node: nodes, projectId: workflows.projectId })
        .from(nodes)
        .innerJoin(workflows, eq(nodes.workflowId, workflows.id))
        .where(and(eq(nodes.workspaceId, scope.workspaceId), eq(nodes.id, nodeId)))
        .get();
      if (row === undefined) return null;
      return { node: toNode(row.node), workflowId: row.node.workflowId, projectId: row.projectId };
    },

    insert: async (scope: Scope, node: Node) => {
      this.#db.insert(nodes).values(this.#nodeValues(scope, node)).run();
    },

    update: async (scope: Scope, node: Node) => {
      const values = this.#nodeValues(scope, node);
      this.#db
        .update(nodes)
        .set({
          kind: values.kind,
          name: values.name,
          positionX: values.positionX,
          positionY: values.positionY,
          inputs: values.inputs,
          outputs: values.outputs,
          config: values.config,
        })
        .where(and(eq(nodes.workspaceId, scope.workspaceId), eq(nodes.id, node.id)))
        .run();
    },

    delete: async (scope: Scope, id: Id) => {
      this.#db
        .delete(nodes)
        .where(and(eq(nodes.workspaceId, scope.workspaceId), eq(nodes.id, id)))
        .run();
    },

    deleteByWorkflow: async (scope: Scope, workflowId: Id) => {
      this.#db
        .delete(nodes)
        .where(and(eq(nodes.workspaceId, scope.workspaceId), eq(nodes.workflowId, workflowId)))
        .run();
    },
  };

  readonly edges: EdgeRepository = {
    listByWorkflow: async (scope: Scope, workflowId: Id) => {
      const rows = this.#db
        .select()
        .from(edges)
        .where(and(eq(edges.workspaceId, scope.workspaceId), eq(edges.workflowId, workflowId)))
        .orderBy(asc(edges.id))
        .all();
      return rows.map(toEdge);
    },

    insert: async (scope: Scope, edge: Edge) => {
      this.#db.insert(edges).values(this.#edgeValues(scope, edge)).run();
    },

    update: async (scope: Scope, edge: Edge) => {
      const values = this.#edgeValues(scope, edge);
      this.#db
        .update(edges)
        .set({
          kind: values.kind,
          fromNodeId: values.fromNodeId,
          fromPortId: values.fromPortId,
          toNodeId: values.toNodeId,
          toPortId: values.toPortId,
          loop: values.loop,
        })
        .where(and(eq(edges.workspaceId, scope.workspaceId), eq(edges.id, edge.id)))
        .run();
    },

    delete: async (scope: Scope, id: Id) => {
      this.#db
        .delete(edges)
        .where(and(eq(edges.workspaceId, scope.workspaceId), eq(edges.id, id)))
        .run();
    },

    deleteByWorkflow: async (scope: Scope, workflowId: Id) => {
      this.#db
        .delete(edges)
        .where(and(eq(edges.workspaceId, scope.workspaceId), eq(edges.workflowId, workflowId)))
        .run();
    },

    deleteByNode: async (scope: Scope, nodeId: Id) => {
      this.#db
        .delete(edges)
        .where(
          and(
            eq(edges.workspaceId, scope.workspaceId),
            or(eq(edges.fromNodeId, nodeId), eq(edges.toNodeId, nodeId)),
          ),
        )
        .run();
    },
  };

  readonly events: EventRepository = {
    append: async (scope: Scope, event: NewEngineEvent) => {
      const row = this.#db
        .insert(events)
        .values({
          workspaceId: scope.workspaceId,
          type: event.type,
          workflowId: event.workflowId ?? null,
          runId: event.runId ?? null,
          payload: toJsonColumn(event.payload, 'event.payload'),
          createdAt: event.createdAt,
        })
        .returning()
        .get();
      return toEvent(row);
    },

    listAfter: async (scope: Scope, afterSeq: number, filter: EventFilter) => {
      const threadTypes = [...THREAD_EVENT_TYPES] as string[];
      // A thread frame (`chat.message`) has no `workflowId`, so it routes only by its
      // `payload.threadId` and must never be swept up by the engine scope (round 4 §2.5). Every
      // engine-scope clause therefore excludes the thread types, and a `thread` subscription adds
      // its own clause matching them on threadId.
      const threadClause = (threadIds: readonly Id[]) =>
        and(
          inArray(events.type, threadTypes),
          or(
            ...threadIds.map(
              (id) => sql`json_extract(${events.payload}, '$.threadId') = ${id}`,
            ),
          ),
        );

      const scoped = (() => {
        // A run filter is exclusive: `GET /runs/:id/events` wants that run's events and nothing
        // else, not that run's events plus everything unscoped.
        if (filter.runIds !== undefined) {
          return filter.runIds.length === 0 ? sql`1 = 0` : inArray(events.runId, filter.runIds);
        }

        const workflowIds = filter.workflowIds ?? [];
        const threadIds = filter.threadIds ?? [];
        const clauses = [];

        if (workflowIds.length > 0) clauses.push(inArray(events.workflowId, workflowIds));
        if (filter.includeEngineScope === true) {
          // Engine scope is the unscoped catch-all — with a workflow list it is the null-workflow
          // events, with none it is everything — but a thread frame is never part of it.
          clauses.push(
            workflowIds.length > 0
              ? and(isNull(events.workflowId), notInArray(events.type, threadTypes))
              : notInArray(events.type, threadTypes),
          );
        }
        if (threadIds.length > 0) clauses.push(threadClause(threadIds));

        if (clauses.length === 0) return sql`1 = 0`;
        return clauses.length === 1 ? clauses[0] : or(...clauses);
      })();

      const rows = this.#db
        .select()
        .from(events)
        .where(and(eq(events.workspaceId, scope.workspaceId), gt(events.seq, afterSeq), scoped))
        .orderBy(asc(events.seq))
        .all();
      return rows.map(toEvent);
    },

    currentSeq: async (scope: Scope) => {
      const row = this.#db
        .select({ seq: sql<number | null>`MAX(${events.seq})` })
        .from(events)
        .where(eq(events.workspaceId, scope.workspaceId))
        .get();
      return row?.seq ?? 0;
    },
  };

  readonly settings: SettingsRepository = {
    get: async (scope: Scope) => {
      const row = this.#db
        .select()
        .from(settings)
        .where(eq(settings.workspaceId, scope.workspaceId))
        .get();
      return SettingsSchema.parse(row === undefined ? { dataDir: '' } : JSON.parse(row.data));
    },

    update: async (scope: Scope, patch: SettingsPatch) => {
      const current = await this.settings.get(scope);
      const next: Settings = SettingsSchema.parse({ ...current, ...patch });

      this.#db
        .insert(settings)
        .values({ workspaceId: scope.workspaceId, data: toJsonColumn(next, 'settings') })
        .onConflictDoUpdate({
          target: settings.workspaceId,
          set: { data: toJsonColumn(next, 'settings') },
        })
        .run();

      return next;
    },
  };

  #nodeValues(scope: Scope, node: Node): typeof nodes.$inferInsert {
    return {
      id: node.id,
      workspaceId: scope.workspaceId,
      workflowId: node.workflowId,
      kind: node.kind,
      name: node.name,
      positionX: node.position.x,
      positionY: node.position.y,
      inputs: toJsonColumn(node.inputs, `node(${node.id}).inputs`),
      outputs: toJsonColumn(node.outputs, `node(${node.id}).outputs`),
      config: toJsonColumn(node.config, `node(${node.id}).config`),
    };
  }

  #edgeValues(scope: Scope, edge: Edge): typeof edges.$inferInsert {
    return {
      id: edge.id,
      workspaceId: scope.workspaceId,
      workflowId: edge.workflowId,
      kind: edge.kind,
      fromNodeId: edge.from.nodeId,
      fromPortId: edge.from.portId,
      toNodeId: edge.to.nodeId,
      toPortId: edge.to.portId,
      loop: edge.loop === undefined ? null : toJsonColumn(edge.loop, `edge(${edge.id}).loop`),
    };
  }
}
