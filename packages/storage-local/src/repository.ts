import { AsyncLocalStorage } from 'node:async_hooks';

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
  KbChunkRepository,
  KbDocumentRepository,
  KnowledgeBaseRepository,
  MemoryRepository,
  SummaryCacheRepository,
  UsageRepository,
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
import { namesKnowledgeBase } from '@ace/engine';
import type BetterSqlite3 from 'better-sqlite3';
import { and, asc, eq, gt, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { buildDefaultPolicy } from './default-policy.js';
import {
  detectVectorExtension,
  Fts5KeywordIndex,
  SqliteVectorIndex,
  VectorStore,
  type VectorExtension,
} from './indexes.js';
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
  createKbChunkRepository,
  createKbDocumentRepository,
  createKnowledgeBaseRepository,
  createMemoryRepository,
  createSummaryCacheRepository,
} from './repository-round5.js';
import { createUsageRepository } from './repository-usage.js';
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
 * Serialises use of the one local connection.
 *
 * `Repository` is async so the same interface can front Postgres later, but that means a
 * transaction body can await between statements. With a single SQLite connection an interleaved
 * call would silently join the open transaction, so every call queues instead.
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

export interface SqliteRepositoryOptions {
  /**
   * How chunk vectors are written (F8). Defaults to what the connection has loaded — `openDatabase`
   * loads sqlite-vec — so `kbChunks` and `SqliteVectorIndex` on one handle always agree.
   */
  vectorExtension?: VectorExtension;
}

/**
 * Every repository of the `Repository` port this adapter composes — the port's members but
 * `transaction`, which is the gate itself. The constructor puts exactly these behind the connection
 * gate (NFR-REL-02), and a test checks the list against the port's members, so a repository added
 * later without a gate fails it.
 */
export const GATED_REPOSITORIES = [
  'projects',
  'workflows',
  'nodes',
  'edges',
  'events',
  'settings',
  'providers',
  'models',
  'priceTables',
  'runs',
  'nodeRuns',
  'guardrailPolicies',
  'guardrailVerdicts',
  'approvals',
  'artifacts',
  'toolCalls',
  'mcpServers',
  'messages',
  'chatThreads',
  'chatMessages',
  'knowledgeBases',
  'kbDocuments',
  'kbChunks',
  'memory',
  'summaryCache',
  'usage',
] as const satisfies readonly Exclude<keyof Repository, 'transaction'>[];

type GatedRepository = (typeof GATED_REPOSITORIES)[number];

/** Whoever holds the connection right now: a plain call, a transaction, or an `exclusive` body. */
interface Holder {
  token: symbol;
  /** True while a transaction is open for this holder. */
  transaction: boolean;
}

export class SqliteRepository implements Repository {
  readonly #db: Db;
  readonly #sqlite: BetterSqlite3.Database;
  readonly #mutex = new Mutex();
  /**
   * Which holder the running code belongs to. A holder runs inside this store with a fresh token,
   * and every await of its body carries the token along, so a call can tell "I am part of the work
   * holding the connection" from "someone else arrived while the connection is held".
   */
  readonly #context = new AsyncLocalStorage<symbol>();
  #holder: Holder | undefined;
  /**
   * The repository a transaction hands its body: the same repositories, not gated, because the
   * body *is* the holder. Valid for the body's duration, as any transaction handle is.
   */
  readonly #owner: Repository;

  /** Indexes on the same connection, behind the same gate (F8): wire these, not fresh ones. */
  readonly vectorIndex: SqliteVectorIndex;
  readonly keywordIndex: Fts5KeywordIndex;

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

  /* Round 5 (Arch §15.3, §21.3). Optional on the port (D218's pattern); all implemented here. */
  readonly knowledgeBases: KnowledgeBaseRepository;
  readonly kbDocuments: KbDocumentRepository;
  readonly kbChunks: KbChunkRepository;
  readonly memory: MemoryRepository;
  readonly summaryCache: SummaryCacheRepository;
  readonly usage: UsageRepository;

  constructor(db: Db, sqlite: BetterSqlite3.Database, options: SqliteRepositoryOptions = {}) {
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

    // Round 5. A chunk write, a document delete and a base delete each touch the chunk rows, both
    // vector stores and (through the trigger) the FTS index, so they borrow this transaction too.
    const vectorExtension = options.vectorExtension ?? detectVectorExtension(sqlite);
    const vectors = new VectorStore(sqlite, vectorExtension);
    this.knowledgeBases = createKnowledgeBaseRepository(db, inTransaction, vectors);
    this.kbDocuments = createKbDocumentRepository(db, inTransaction, vectors);
    this.kbChunks = createKbChunkRepository(db, inTransaction, vectors);
    this.memory = createMemoryRepository(db);
    this.summaryCache = createSummaryCacheRepository(db, sqlite);
    this.usage = createUsageRepository(sqlite);

    // The gate (NFR-REL-02). Every repository is composed twice: as built, for a transaction body,
    // which holds the connection; and gated, for everyone else, so a call that is not part of the
    // work holding the connection waits for it to finish instead of landing inside it.
    const owner: Repository = {
      // Through the gate, not straight into the body: from inside the open transaction this joins
      // it, as before; from a handle kept past its commit it queues and opens a transaction of its
      // own, rather than running ungated inside whatever batch holds the connection by then.
      transaction: (fn) => this.transaction(() => fn(owner)),
      projects: this.projects,
      workflows: this.workflows,
      nodes: this.nodes,
      edges: this.edges,
      events: this.events,
      settings: this.settings,
      providers: this.providers,
      models: this.models,
      priceTables: this.priceTables,
      runs: this.runs,
      nodeRuns: this.nodeRuns,
      guardrailPolicies: this.guardrailPolicies,
      guardrailVerdicts: this.guardrailVerdicts,
      approvals: this.approvals,
      artifacts: this.artifacts,
      toolCalls: this.toolCalls,
      mcpServers: this.mcpServers,
      messages: this.messages,
      chatThreads: this.chatThreads,
      chatMessages: this.chatMessages,
      knowledgeBases: this.knowledgeBases,
      kbDocuments: this.kbDocuments,
      kbChunks: this.kbChunks,
      memory: this.memory,
      summaryCache: this.summaryCache,
      usage: this.usage,
    };
    this.#owner = owner;

    // The public members are the gated copies, every one named in `GATED_REPOSITORIES`. They are
    // readonly to everyone else; only here, once, are they swapped for their gated selves.
    const members = this as unknown as Record<GatedRepository, object>;
    for (const name of GATED_REPOSITORIES) members[name] = this.#gate(members[name]);

    const hold = <T>(fn: () => Promise<T>): Promise<T> => this.#hold(() => fn());
    this.vectorIndex = new SqliteVectorIndex(sqlite, { vectorExtension, hold });
    this.keywordIndex = new Fts5KeywordIndex(sqlite, { hold });
  }

  /** The holder the running code belongs to, if it holds the connection. */
  #ownHolder(): Holder | undefined {
    const holder = this.#holder;
    return holder !== undefined && this.#context.getStore() === holder.token ? holder : undefined;
  }

  /**
   * Runs `fn` holding the connection. Code that already holds it — a transaction body, or a plain
   * call that calls another method — runs at once, as part of that work. Anyone else queues
   * behind whoever holds it and runs after they finish, whatever they committed or rolled back. A
   * plain call keeps the connection for its whole duration, so a transaction cannot open half way
   * through a call that reads, awaits, then writes.
   */
  #hold<T>(fn: (holder: Holder) => Promise<T>): Promise<T> {
    const own = this.#ownHolder();
    if (own !== undefined) return fn(own);

    return this.#mutex.runExclusive(async () => {
      const holder: Holder = { token: Symbol('holder'), transaction: false };
      this.#holder = holder;
      try {
        return await this.#context.run(holder.token, () => fn(holder));
      } finally {
        this.#holder = undefined;
      }
    });
  }

  /** The same repository, every method behind `#hold`. Repositories are plain objects of methods. */
  #gate<R extends object>(repository: R): R {
    const gated: Record<string, unknown> = {};
    for (const [name, member] of Object.entries(repository)) {
      gated[name] =
        typeof member === 'function'
          ? (...args: unknown[]) =>
              this.#hold(async () => (member as (...params: unknown[]) => unknown)(...args))
          : member;
    }
    return gated as R;
  }

  /**
   * Runs `fn` holding the connection with no transaction open — for the statements SQLite refuses
   * inside a transaction, `VACUUM INTO` and `ATTACH`, which the backup store runs on this same
   * connection (F12). Called from inside a transaction's own body it would wait for itself
   * forever, so it refuses instead.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#ownHolder()?.transaction === true) {
      return Promise.reject(
        new Error('exclusive() cannot run inside a transaction of this repository'),
      );
    }
    return this.#hold(() => fn());
  }

  /**
   * One transaction per call (NFR-REL-02, TC-NFR-006). A throw anywhere in the body rolls the whole
   * batch back, so a graph-ops batch is fully applied or not applied at all — never half written.
   *
   * A call made from the open transaction's own body — `tx.projects.create` inside a batch, or a
   * nested `tx.transaction` — joins it rather than starting a second one, and a throw there rolls
   * back the whole outer batch. Any other caller — a background ingestion write arriving while an
   * unrelated batch is awaiting, transactional or not — waits for that batch to commit or roll back
   * and then runs, so one caller's rollback can never take another's writes with it. A body's
   * detached work that outlives its commit queues like any other caller.
   */
  async transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T> {
    return this.#hold(async (holder) => {
      if (holder.transaction) return fn(this.#owner);

      this.#sqlite.exec('BEGIN IMMEDIATE');
      holder.transaction = true;
      try {
        const result = await fn(this.#owner);
        this.#sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        this.#sqlite.exec('ROLLBACK');
        throw error;
      } finally {
        holder.transaction = false;
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
        .filter((node) => 'providerId' in node.config && node.config.providerId === providerId),

    // The same quoted-id prefilter as `listByProvider`, then the exact rule (FR-PRV-005, round 5).
    listByKnowledgeBase: async (scope: Scope, knowledgeBaseId: Id) =>
      this.#db
        .select()
        .from(nodes)
        .where(
          and(
            eq(nodes.workspaceId, scope.workspaceId),
            sql`${nodes.config} LIKE ${`%"${knowledgeBaseId}"%`}`,
          ),
        )
        .all()
        .map(toNode)
        .filter((node) => namesKnowledgeBase(node, knowledgeBaseId)),

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
          or(...threadIds.map((id) => sql`json_extract(${events.payload}, '$.threadId') = ${id}`)),
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
