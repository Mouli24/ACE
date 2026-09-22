import type {
  CursorQuery,
  Edge,
  Id,
  Node,
  Page,
  Project,
  Settings,
  SettingsPatch,
  Timestamp,
  Workflow,
} from '@ace/contracts';

import type {
  ModelRepository,
  NodeRunRepository,
  PriceTableRepository,
  ProviderRepository,
  RunRepository,
} from './run-repository.js';
import type { Scope } from './scope.js';

/**
 * One row of the append-only event log (FR-EXE-014, Arch §21.4).
 *
 * This shape is deliberately engine-side and not in `@ace/contracts`: §2 of the round 1 contract
 * specifies the WebSocket *frames*, and `contracts/src/events.ts` is an empty placeholder for the
 * round 2 contract. The persisted row stays an engine concern until that round names it.
 */
export interface EngineEvent {
  /** Global, monotonic and never reused — the anchor `resume { afterSeq }` replays from. */
  seq: number;
  type: string;
  /** Which workflow the event belongs to, when it belongs to one. */
  workflowId?: Id;
  /** Which run the event belongs to (round 2 onward). */
  runId?: Id;
  payload: unknown;
  createdAt: Timestamp;
  /**
   * True for an event that is published to live subscribers but never written to the log
   * (round 2 §2.4: `node.token`). A transient event has no meaningful `seq` and is never replayed
   * by `resume`, because the `node.output` that follows carries the same text in one piece.
   */
  transient?: boolean;
}

/** An event before the log has given it a `seq`. */
export type NewEngineEvent = Omit<EngineEvent, 'seq'>;

/** Which events `listAfter` should return. */
export interface EventFilter {
  workflowIds?: Id[];
  /**
   * Events of these runs, whatever workflow they belong to. `GET /runs/:id/events` uses it, so
   * replaying one run does not mean reading the whole log and filtering in memory.
   */
  runIds?: Id[];
  /** True when the caller is subscribed to the engine scope and wants unscoped events too. */
  includeEngineScope?: boolean;
}

export interface ProjectRepository {
  create(scope: Scope, project: Project): Promise<Project>;
  get(scope: Scope, id: Id): Promise<Project | null>;
  list(scope: Scope, page: CursorQuery): Promise<Page<Project>>;
  update(
    scope: Scope,
    id: Id,
    patch: { name?: string; lastOpenedAt?: Timestamp; updatedAt: Timestamp },
  ): Promise<Project | null>;
  delete(scope: Scope, id: Id): Promise<boolean>;
}

export interface WorkflowRepository {
  create(scope: Scope, workflow: Workflow): Promise<Workflow>;
  get(scope: Scope, id: Id): Promise<Workflow | null>;
  listByProject(scope: Scope, projectId: Id, page: CursorQuery): Promise<Page<Workflow>>;
  update(
    scope: Scope,
    id: Id,
    patch: { name?: string; version?: number; updatedAt: Timestamp },
  ): Promise<Workflow | null>;
  delete(scope: Scope, id: Id): Promise<boolean>;
}

export interface NodeRepository {
  listByWorkflow(scope: Scope, workflowId: Id): Promise<Node[]>;
  /**
   * Every node, in any workflow, whose config names this provider (FR-PRV-005). Deleting a
   * provider has to name the nodes it would break before it is allowed to happen.
   */
  listByProvider(scope: Scope, providerId: Id): Promise<Node[]>;
  insert(scope: Scope, node: Node): Promise<void>;
  update(scope: Scope, node: Node): Promise<void>;
  delete(scope: Scope, id: Id): Promise<void>;
  deleteByWorkflow(scope: Scope, workflowId: Id): Promise<void>;
}

export interface EdgeRepository {
  listByWorkflow(scope: Scope, workflowId: Id): Promise<Edge[]>;
  insert(scope: Scope, edge: Edge): Promise<void>;
  update(scope: Scope, edge: Edge): Promise<void>;
  delete(scope: Scope, id: Id): Promise<void>;
  deleteByWorkflow(scope: Scope, workflowId: Id): Promise<void>;
  /** Used by `delete_node`, which takes its edges with it (§2.6). */
  deleteByNode(scope: Scope, nodeId: Id): Promise<void>;
}

export interface EventRepository {
  /** Appends and returns the row with the `seq` the log assigned. Never updates or deletes. */
  append(scope: Scope, event: NewEngineEvent): Promise<EngineEvent>;
  listAfter(scope: Scope, afterSeq: number, filter: EventFilter): Promise<EngineEvent[]>;
  currentSeq(scope: Scope): Promise<number>;
}

export interface SettingsRepository {
  get(scope: Scope): Promise<Settings>;
  update(scope: Scope, patch: SettingsPatch): Promise<Settings>;
}

/**
 * The relational store (Arch §7: SQLite locally, Postgres hosted).
 *
 * Methods are async so the same interface can front an async driver; the local adapter serialises
 * transactions so an awaited body cannot interleave with another writer on the one connection.
 */
export interface Repository {
  /**
   * Runs `fn` inside one transaction. Everything the body writes commits together or not at all
   * (NFR-REL-02, TC-NFR-006): a throw rolls the whole batch back.
   */
  transaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T>;

  projects: ProjectRepository;
  workflows: WorkflowRepository;
  nodes: NodeRepository;
  edges: EdgeRepository;
  events: EventRepository;
  settings: SettingsRepository;

  /* Round 2 (Arch §15.3). */
  providers: ProviderRepository;
  models: ModelRepository;
  priceTables: PriceTableRepository;
  runs: RunRepository;
  nodeRuns: NodeRunRepository;
}
