import type {
  Artifact,
  CheckCommand,
  ChatMessage,
  ChatThread,
  CursorQuery,
  Edge,
  Id,
  McpServer,
  McpServerStatus,
  Message,
  MessageQuery,
  Node,
  Page,
  Project,
  Settings,
  SettingsPatch,
  Timestamp,
  ToolCall,
  Workflow,
} from '@ace/contracts';

import type {
  ApprovalRepository,
  GuardrailPolicyRepository,
  GuardrailVerdictRepository,
} from './guardrail-repository.js';
import type {
  ModelRepository,
  NodeRunRepository,
  PriceTableRepository,
  ProviderRepository,
  RunRepository,
} from './run-repository.js';
import type {
  KbChunkRepository,
  KbDocumentRepository,
  KnowledgeBaseRepository,
  MemoryRepository,
  SummaryCacheRepository,
  UsageRepository,
} from './knowledge.js';
import type { BundleRepository, SkillRepository } from './capabilities.js';
import type { Scope } from './scope.js';
import type { SecretRepository } from './secrets.js';
import type {
  ProjectNoteRepository,
  ResponsibilityRepository,
  SuggestionRepository,
} from './suggestions.js';
import type {
  TaskActivityRepository,
  TaskCheckRepository,
  TaskDeliveryRepository,
  TaskExecutionRepository,
  TaskRepository,
  TaskReviewRepository,
  TaskScheduleRepository,
  TaskWorkspaceRepository,
} from './tasks.js';

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
  /**
   * Persisted thread events (`chat.message`) whose `payload.threadId` is one of these — a direct
   * chat's `resume` replays its own turns and no run traffic (round 4 §2.5, FR-CHAT-006). Thread
   * events carry no `workflowId`, so they are matched by this and never by the engine scope.
   */
  threadIds?: Id[];
  /** True when the caller is subscribed to the engine scope and wants unscoped events too. */
  includeEngineScope?: boolean;
}

export interface ProjectRepository {
  /**
   * Creates the project **and its default guardrail policy**, in one transaction (FR-GRD-018, D10).
   * No caller has to remember the policy, and no project can exist without one.
   */
  create(scope: Scope, project: Project): Promise<Project>;
  get(scope: Scope, id: Id): Promise<Project | null>;
  list(scope: Scope, page: CursorQuery): Promise<Page<Project>>;
  update(
    scope: Scope,
    id: Id,
    patch: {
      name?: string;
      lastOpenedAt?: Timestamp;
      /** Round 3 §2.3: the per-run cost cap. `null` removes it, `undefined` leaves it (D72). */
      maxCostPerRunUsd?: number | null;
      /* ACE parity P0 (D269, D271): `undefined` leaves a field, `null` clears the setup command. */
      paused?: boolean;
      buildCapacity?: number;
      checkCommands?: CheckCommand[];
      setupCommand?: string | null;
      /* ACE parity P1 (D278): `null` clears either. */
      previewCommand?: string | null;
      previewUrl?: string | null;
      updatedAt: Timestamp;
    },
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

/** A node with the workflow and project it belongs to — what `getById` resolves (FR-CHAT-004). */
export interface ResolvedNode {
  node: Node;
  workflowId: Id;
  projectId: Id;
}

export interface NodeRepository {
  listByWorkflow(scope: Scope, workflowId: Id): Promise<Node[]>;
  /**
   * The node with `nodeId`, plus the workflow and the project it belongs to, or null. Every other
   * lookup here takes a workflow id, but `POST /nodes/:id/chat` knows only the node id, and a direct
   * chat must reach the node's model and context policy and — through the project — its default
   * guardrail policy (FR-CHAT-004). This is the workflow → project join the chat service's
   * `resolveNode` is built from, so the gateway no longer scans every workflow to find one node.
   */
  getById(scope: Scope, nodeId: Id): Promise<ResolvedNode | null>;
  /**
   * Every node, in any workflow, whose config names this provider (FR-PRV-005). Deleting a
   * provider has to name the nodes it would break before it is allowed to happen.
   */
  listByProvider(scope: Scope, providerId: Id): Promise<Node[]>;
  /**
   * Every agent attached to this knowledge base and every Retrieval node searching it, in any
   * workflow (round 5, FR-PRV-005): what removing the provider the base embeds with would break.
   */
  listByKnowledgeBase(scope: Scope, knowledgeBaseId: Id): Promise<Node[]>;
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

/* -------------------------------------------------------------------------- */
/* Round 4 (Arch §15.3): artifacts, tool calls, MCP servers, messages, chat    */
/* -------------------------------------------------------------------------- */

/**
 * The artifact metadata store (round 4 §2.1, FR-MM-001..004, Arch §15.4).
 *
 * The bytes live in the `BlobStore`, keyed by `hash`; this keeps the row. Dedupe is a database
 * constraint — `getByHash` is how the upload path answers "these exact bytes are already stored"
 * before it writes a second row (FR-MM-002). `touch` moves the `lastReferencedAt` clock the
 * retention sweep of Arch §15.4 counts from, and `unreferencedBefore` is the query that sweep runs;
 * the policy (when to run it, and deleting the blob) stays the engine's.
 */
export interface ArtifactRepository {
  create(scope: Scope, artifact: Artifact): Promise<Artifact>;
  getById(scope: Scope, id: Id): Promise<Artifact | null>;
  /** The stored row with these bytes, or null — the dedupe lookup (FR-MM-002). */
  getByHash(scope: Scope, hash: string): Promise<Artifact | null>;
  /** Newest first, so the uploads panel shows the most recent at the top. */
  list(scope: Scope, page: CursorQuery): Promise<Page<Artifact>>;
  /** Sets `lastReferencedAt`; null when there is no such artifact. */
  touch(scope: Scope, id: Id, at: Timestamp): Promise<Artifact | null>;
  /**
   * The sweep candidates of Arch §15.4: artifacts whose reference time (`lastReferencedAt`, or
   * `createdAt` when it was never referenced) is before `before` **and** which no live reference
   * points at — an Input node's `artifactIds`, a node run's output or input envelopes, a timeline
   * message, or a chat message. The engine decides `before` (now − 7 days) and does the deleting.
   */
  unreferencedBefore(scope: Scope, before: Timestamp): Promise<Artifact[]>;
  delete(scope: Scope, id: Id): Promise<boolean>;
}

export interface ToolCallRepository {
  /**
   * Appends a logged call (FR-TOOL-009) and mirrors it onto its node run's `toolCalls` list in the
   * same transaction, so the denormalised copy the `NodeRun` contract carries cannot drift — the
   * same one-write-path rule as verdicts and approvals. `runId` is passed alongside because the
   * `ToolCall` contract carries only `nodeRunId`, and the inspector filters by run.
   */
  append(scope: Scope, runId: Id, call: ToolCall): Promise<ToolCall>;
  /** In the order they were made, which is the order the agent's tool loop made them. */
  listByNodeRun(scope: Scope, nodeRunId: Id): Promise<ToolCall[]>;
  listByRun(scope: Scope, runId: Id): Promise<ToolCall[]>;
}

/** What a health check may change on an MCP server (FR-TOOL-007, D16). */
export interface McpServerPatch {
  status?: McpServerStatus;
  toolCount?: number;
  lastCheckedAt?: Timestamp;
  /** `null` clears a previous error once the server reconnects. */
  error?: string | null;
}

export interface McpServerRepository {
  create(scope: Scope, server: McpServer): Promise<McpServer>;
  get(scope: Scope, id: Id): Promise<McpServer | null>;
  /** Oldest first — the order the user added them. */
  list(scope: Scope): Promise<McpServer[]>;
  updateStatus(scope: Scope, id: Id, patch: McpServerPatch): Promise<McpServer | null>;
  delete(scope: Scope, id: Id): Promise<boolean>;
}

export interface MessageRepository {
  /** Appends one timeline row (FR-CHAT-001). Never updates: the timeline is append-only. */
  append(scope: Scope, message: Message): Promise<Message>;
  /**
   * `GET /workflows/:id/messages` (FR-CHAT-002): the workflow's timeline, filtered by any
   * combination of run, node and type, paged by cursor. Oldest first, so a reconnect that replays
   * from a cursor sees the identical order.
   */
  query(scope: Scope, workflowId: Id, query: MessageQuery): Promise<Page<Message>>;
}

export interface ChatThreadRepository {
  create(scope: Scope, thread: ChatThread): Promise<ChatThread>;
  get(scope: Scope, id: Id): Promise<ChatThread | null>;
  /** `GET /nodes/:id/chat/threads` — the agent's threads, oldest first. */
  listByNode(scope: Scope, nodeId: Id): Promise<ChatThread[]>;
  /** Moves `updatedAt` when a turn is added, so the thread list can sort by recency. */
  touch(scope: Scope, id: Id, updatedAt: Timestamp): Promise<ChatThread | null>;
  /** Removes the thread and every one of its messages in one transaction. */
  delete(scope: Scope, id: Id): Promise<boolean>;
}

export interface ChatMessageRepository {
  append(scope: Scope, message: ChatMessage): Promise<ChatMessage>;
  /** In the order they were sent, which is the order the conversation happened. */
  listByThread(scope: Scope, threadId: Id): Promise<ChatMessage[]>;
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

  /* Round 3 (Arch §15.3). */
  guardrailPolicies: GuardrailPolicyRepository;
  guardrailVerdicts: GuardrailVerdictRepository;
  approvals: ApprovalRepository;

  /* Round 4 (Arch §15.3): artifacts, tool calls, MCP servers, timeline messages and direct chat. */
  artifacts: ArtifactRepository;
  toolCalls: ToolCallRepository;
  mcpServers: McpServerRepository;
  messages: MessageRepository;
  chatThreads: ChatThreadRepository;
  chatMessages: ChatMessageRepository;

  /**
   * Round 5 (Arch §15.3, §21.3): knowledge bases, memory, the summary cache and usage read models.
   * Optional until the storage adapter implements them, D218's pattern; the engine services that
   * need one fail clearly when it is absent.
   */
  knowledgeBases?: KnowledgeBaseRepository;
  kbDocuments?: KbDocumentRepository;
  kbChunks?: KbChunkRepository;
  memory?: MemoryRepository;
  summaryCache?: SummaryCacheRepository;
  usage?: UsageRepository;

  /**
   * ACE parity P0 (D268, D269): tasks and what belongs to them. Optional, D218's pattern: the task
   * service fails clearly when the adapter does not provide them.
   */
  tasks?: TaskRepository;
  taskWorkspaces?: TaskWorkspaceRepository;
  taskExecutions?: TaskExecutionRepository;
  taskChecks?: TaskCheckRepository;
  taskReviews?: TaskReviewRepository;
  taskDeliveries?: TaskDeliveryRepository;
  taskActivity?: TaskActivityRepository;
  /** ACE parity P1 (D277). */
  taskSchedules?: TaskScheduleRepository;

  /** ACE parity P2 (D280, D281). */
  responsibilities?: ResponsibilityRepository;
  suggestions?: SuggestionRepository;
  projectNotes?: ProjectNoteRepository;
  /**
   * ACE parity P1 (D272, D273): installed skills and imported bundles. Optional, D218's pattern: a
   * store without them holds no skill, so an agent naming one is refused at pre-flight.
   */
  skills?: SkillRepository;
  bundles?: BundleRepository;
  /**
   * ACE parity P1 (D274): secrets' names, descriptions and project scopes — never their values,
   * which live only in the `SecretStore`. Optional, D218's pattern: the secret service fails clearly
   * when the adapter does not provide it.
   */
  secrets?: SecretRepository;
}
