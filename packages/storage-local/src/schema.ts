import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * The six tables round 1 needs (A1 item 2). The rest of Arch §15.3 arrives with the rounds that
 * use them. There is deliberately no `ports` table: §2.4 carries a node's ports inside the node,
 * and they are re-derived server-side by `derivePorts`, so storing them separately would create a
 * second copy that could drift.
 *
 * Every table carries `workspaceId`. Local mode writes the constant 'local'; hosted mode has real
 * values and the same queries keep tenants apart (BR-18, NFR-PORT-01).
 */

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    folderPath: text('folder_path').notNull(),
    lastOpenedAt: text('last_opened_at'),
    /** Round 3 §2.3: the per-run cost cap, null when the project has none (FR-GRD-008). */
    maxCostPerRunUsd: real('max_cost_per_run_usd'),
    /* ACE parity P0 Build settings (D269, D271). NULL reads as the default. */
    paused: integer('paused', { mode: 'boolean' }).notNull().default(false),
    buildCapacity: integer('build_capacity'),
    /** JSON `CheckCommand[]`. */
    checkCommands: text('check_commands'),
    setupCommand: text('setup_command'),
    /* ACE parity P1 preview (D278). NULL is none. */
    previewCommand: text('preview_command'),
    previewUrl: text('preview_url'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('projects_workspace_idx').on(table.workspaceId, table.id)],
);

export const workflows = sqliteTable(
  'workflows',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    formatVersion: integer('format_version').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('workflows_project_idx').on(table.workspaceId, table.projectId, table.id)],
);

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    positionX: real('position_x').notNull(),
    positionY: real('position_y').notNull(),
    /** JSON — derived by `derivePorts`, stored so a read needs no recomputation. */
    inputs: text('inputs').notNull(),
    outputs: text('outputs').notNull(),
    /** JSON, discriminated by `kind` (§2.4). */
    config: text('config').notNull(),
  },
  (table) => [index('nodes_workflow_idx').on(table.workspaceId, table.workflowId, table.id)],
);

export const edges = sqliteTable(
  'edges',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    kind: text('kind').notNull(),
    fromNodeId: text('from_node_id').notNull(),
    fromPortId: text('from_port_id').notNull(),
    toNodeId: text('to_node_id').notNull(),
    toPortId: text('to_port_id').notNull(),
    /** JSON LoopConfig, null on a data edge. */
    loop: text('loop'),
  },
  (table) => [
    index('edges_workflow_idx').on(table.workspaceId, table.workflowId, table.id),
    index('edges_from_idx').on(table.workspaceId, table.fromNodeId),
    index('edges_to_idx').on(table.workspaceId, table.toNodeId),
  ],
);

/**
 * The append-only log (BR-04). `seq` is an AUTOINCREMENT primary key, so SQLite never reuses a
 * value even after a delete — which is what makes `resume { afterSeq }` sound.
 */
export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    workspaceId: text('workspace_id').notNull(),
    type: text('type').notNull(),
    workflowId: text('workflow_id'),
    runId: text('run_id'),
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('events_workflow_idx').on(table.workspaceId, table.workflowId, table.seq),
    index('events_seq_idx').on(table.workspaceId, table.seq),
  ],
);

/** One row per workspace holding the whole §2.7 Settings object. */
export const settings = sqliteTable(
  'settings',
  {
    workspaceId: text('workspace_id').notNull(),
    data: text('data').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId] })],
);

/* -------------------------------------------------------------------------- */
/* Round 2 (Arch §15.3): providers, catalog, price tables, runs, node runs     */
/* -------------------------------------------------------------------------- */

/**
 * There is deliberately no key column here. A provider's API key lives in the OS keychain through
 * `SecretStore`; this table records only whether one is set (FR-PRV-002, BR-07).
 */
export const providers = sqliteTable(
  'providers',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    baseUrl: text('base_url'),
    keySet: integer('key_set', { mode: 'boolean' }).notNull(),
    status: text('status').notNull(),
    statusMessage: text('status_message'),
    lastCheckedAt: text('last_checked_at'),
    concurrency: integer('concurrency').notNull(),
    /** X1 (D262): a CLI provider's permission preset; NULL for every other type. */
    cliPermission: text('cli_permission'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('providers_workspace_idx').on(table.workspaceId, table.id)],
);

/** One row per provider model, refreshed wholesale so a withdrawn model disappears. */
export const models = sqliteTable(
  'models',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    /** JSON DataType[]. */
    inputTypes: text('input_types').notNull(),
    outputTypes: text('output_types').notNull(),
    contextWindow: integer('context_window').notNull(),
    supportsTools: integer('supports_tools', { mode: 'boolean' }).notNull(),
    supportsJson: integer('supports_json', { mode: 'boolean' }).notNull(),
    available: integer('available', { mode: 'boolean' }).notNull(),
    source: text('source').notNull(),
    lastCheckedAt: text('last_checked_at').notNull(),
    /** JSON ModelPricing, null for a model with no published price. */
    pricing: text('pricing'),
  },
  (table) => [index('models_provider_idx').on(table.workspaceId, table.providerId, table.modelId)],
);

/** Immutable price tables (FR-OBS-003): a past estimate must stay reproducible. */
export const priceTables = sqliteTable(
  'price_tables',
  {
    workspaceId: text('workspace_id').notNull(),
    version: text('version').notNull(),
    data: text('data').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.version] })],
);

/** `snapshot` is written with the row and never updated (BR-04). */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    projectId: text('project_id').notNull(),
    status: text('status').notNull(),
    haltReason: text('halt_reason'),
    snapshot: text('snapshot').notNull(),
    inputs: text('inputs').notNull(),
    preflightIssues: text('preflight_issues').notNull(),
    totals: text('totals').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    durationMs: integer('duration_ms'),
    finalOutput: text('final_output'),
    /**
     * "Paused since" (round 3 §2.1, FR-CTL-002). A resume clears the column rather than leaving
     * the timestamp of a pause the run is no longer in (D106).
     */
    pausedAt: text('paused_at'),
    /**
     * JSON `RunAction[]` — `allowedRunActions(status)`, stamped wherever the status is set, so the
     * UI never guesses which controls a run accepts (FR-CTL-006, D71, D76).
     */
    allowedActions: text('allowed_actions'),
    /** JSON `BudgetHalt`: which cap tripped and by how much, set only on a `budget_exceeded` halt (FR-GRD-008, D80). */
    budgetHalt: text('budget_halt'),
    /** The run a restart copied its snapshot and inputs from (FR-CTL-004). */
    restartedFromRunId: text('restarted_from_run_id'),
  },
  (table) => [
    index('runs_workflow_idx').on(table.workspaceId, table.workflowId, table.id),
    index('runs_status_idx').on(table.workspaceId, table.status),
  ],
);

export const nodeRuns = sqliteTable(
  'node_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    nodeId: text('node_id').notNull(),
    iteration: integer('iteration').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull(),
    failureReason: text('failure_reason'),
    error: text('error'),
    modelUsed: text('model_used'),
    inputEnvelopes: text('input_envelopes').notNull(),
    output: text('output'),
    /** JSON `{ version, text }`, redacted before it gets here (FR-PRM-005). */
    prompt: text('prompt'),
    usage: text('usage').notNull(),
    /**
     * JSON `Verdict[]`, the denormalised copy the `NodeRun` contract requires. `guardrail_verdicts`
     * is the table of record; the verdict repository writes both in one transaction so the two can
     * never drift, and nothing else may write this column.
     */
    verdicts: text('verdicts').notNull(),
    toolCalls: text('tool_calls').notNull(),
    /** JSON `ApprovalDecision[]`, kept in step with `approvals` by the approval repository. */
    approvals: text('approvals'),
    /** JSON `GuardrailPolicyRef` — the policy and version this node run was checked against. */
    guardrailPolicy: text('guardrail_policy'),
    /** On a loop's last iteration: why the loop stopped (round 3 §2.4). */
    loopStop: text('loop_stop'),
    /** Set when Start from node reused an earlier node run instead of executing (FR-EXE-013). */
    reusedFromNodeRunId: text('reused_from_node_run_id'),
    /** JSON `NodeRunSource[]`: the chunks this node run's context used (round 5 §2.4, FR-RAG-007). */
    sources: text('sources'),
    /** JSON `NodeRunSource[]`: chunks found but dropped to fit the context budget (D233). */
    droppedSources: text('dropped_sources'),
    /** JSON `MemoryOp[]`: the `__memory` ops this node run applied, in order (§2.2, D230). */
    memoryOps: text('memory_ops'),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    index('node_runs_run_idx').on(table.workspaceId, table.runId, table.id),
    /** The daily budget aggregate scans a day's node runs (round 3 §2.3, FR-GRD-008). */
    index('node_runs_started_idx').on(table.workspaceId, table.startedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Round 3 (Arch §15.3): guardrail policies, verdicts, approvals               */
/* -------------------------------------------------------------------------- */

/**
 * A policy version (round 3 §2.2, FR-GRD-001). A PATCH never edits in place — the caller writes
 * version + 1 — so this table holds every version and `id` is the version's own row id.
 *
 * At most one row per project may carry `is_project_default` (FR-GRD-018). The partial unique index
 * makes that a database constraint rather than a convention the repository has to remember;
 * `setDefault` still moves the flag inside one transaction so the invariant is never briefly false.
 */
export const guardrailPolicies = sqliteTable(
  'guardrail_policies',
  {
    id: text('id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    version: integer('version').notNull(),
    isProjectDefault: integer('is_project_default', { mode: 'boolean' }).notNull(),
    /** JSON `GuardrailCheck[]`. */
    checks: text('checks').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.version] }),
    index('guardrail_policies_project_idx').on(table.workspaceId, table.projectId, table.id),
    uniqueIndex('guardrail_policies_default_idx')
      .on(table.workspaceId, table.projectId)
      .where(sql`is_project_default = 1`),
  ],
);

/**
 * One check's outcome on one node run (FR-GRD-014, FR-GRD-015).
 *
 * There is deliberately **no value column**. A redact verdict records the *types* it replaced and
 * nothing else — the text it found never reaches a table. `Verdict` is a strict contract with no
 * value field, and this column list is asserted by a test so one cannot be added quietly.
 */
export const guardrailVerdicts = sqliteTable(
  'guardrail_verdicts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    nodeRunId: text('node_run_id').notNull(),
    point: text('point').notNull(),
    checkType: text('check_type').notNull(),
    action: text('action').notNull(),
    passed: integer('passed', { mode: 'boolean' }).notNull(),
    reason: text('reason').notNull(),
    /** JSON `string[]` of type names such as `["email"]`, null when nothing was redacted. */
    redactedTypes: text('redacted_types'),
    /** JSON `HiddenInstructionType[]` the context point stripped, null when none (round 5, D232). */
    strippedTypes: text('stripped_types'),
    at: text('at').notNull(),
  },
  (table) => [
    index('guardrail_verdicts_node_run_idx').on(table.workspaceId, table.nodeRunId, table.id),
  ],
);

/**
 * An `ask_user` request and, once it is answered, its decision (FR-GRD-013).
 *
 * `decision`, `note` and `decided_at` are null while the node is WAITING, which is what makes
 * "pending" a query rather than a second table: `GET /runs/:id/approvals` filters on
 * (workspace, run, decision IS NULL), and the index is in that order.
 */
export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    nodeRunId: text('node_run_id').notNull(),
    nodeId: text('node_id').notNull(),
    nodeName: text('node_name').notNull(),
    point: text('point').notNull(),
    checkType: text('check_type').notNull(),
    reason: text('reason').notNull(),
    /** ≤ 500 chars and already redacted: a preview carrying a credential is refused (BR-07). */
    preview: text('preview').notNull(),
    requestedAt: text('requested_at').notNull(),
    decision: text('decision'),
    note: text('note'),
    decidedAt: text('decided_at'),
  },
  (table) => [
    index('approvals_run_idx').on(table.workspaceId, table.runId, table.decision),
    index('approvals_node_run_idx').on(table.workspaceId, table.nodeRunId, table.decision),
  ],
);

/* -------------------------------------------------------------------------- */
/* Round 4 (Arch §15.3): artifacts, tool calls, MCP servers, messages, chat    */
/* -------------------------------------------------------------------------- */

/**
 * Every uploaded or produced file (round 4 §2.1, FR-MM-001..004, Arch §15.1, §15.4).
 *
 * The bytes never live here — they are in the content-addressed blob store, keyed by `hash`. This
 * row is the metadata plus the address, so identical bytes uploaded twice share one row (FR-MM-002)
 * and `GET /artifacts/:id/content` streams from the blob store. `hash` is unique per workspace, the
 * database constraint that makes the dedupe correct rather than a convention the repository
 * remembers. `last_referenced_at` is the field Arch §15.4's "unreferenced + 7 days" is counted
 * from; the retention sweep is the engine's, this table gives it the query and the delete.
 */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    hash: text('hash').notNull(),
    mime: text('mime').notNull(),
    name: text('name').notNull(),
    size: integer('size').notNull(),
    createdAt: text('created_at').notNull(),
    lastReferencedAt: text('last_referenced_at'),
  },
  (table) => [
    index('artifacts_workspace_idx').on(table.workspaceId, table.id),
    // Dedupe by content hash is a constraint (FR-MM-002): the same bytes never make a second row.
    uniqueIndex('artifacts_hash_idx').on(table.workspaceId, table.hash),
  ],
);

/**
 * One logged tool call (round 4 §2.2, FR-TOOL-009). `args` is JSON, redacted by the data guardrail
 * before it gets here (BR-07); the full result is never stored, only its ≤ 500-char summary. `runId`
 * is a column of its own — the `ToolCall` contract carries only `nodeRunId`, but the `tool.call`
 * event and the inspector both filter by run, so it is kept alongside rather than parsed out of the
 * node run each time.
 */
export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    runId: text('run_id').notNull(),
    nodeRunId: text('node_run_id').notNull(),
    toolName: text('tool_name').notNull(),
    /** JSON, already redacted (FR-TOOL-009, BR-07). */
    args: text('args').notNull(),
    resultSummary: text('result_summary').notNull(),
    durationMs: integer('duration_ms').notNull(),
    status: text('status').notNull(),
    /** JSON `Verdict[]` — the tool-point verdicts this call recorded. */
    verdicts: text('verdicts').notNull(),
    at: text('at').notNull(),
  },
  (table) => [
    index('tool_calls_node_run_idx').on(table.workspaceId, table.nodeRunId, table.id),
    index('tool_calls_run_idx').on(table.workspaceId, table.runId, table.id),
  ],
);

/**
 * A connected MCP server (round 4 §2.2, FR-TOOL-007, D16). There is no key column: an MCP server
 * is addressed by a command or a URL, and its liveness is `status` + `tool_count` + `error`.
 */
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    transport: text('transport').notNull(),
    command: text('command'),
    /** JSON `string[]`, null on an http server. */
    args: text('args'),
    url: text('url'),
    status: text('status').notNull(),
    toolCount: integer('tool_count').notNull(),
    lastCheckedAt: text('last_checked_at'),
    error: text('error'),
  },
  (table) => [index('mcp_servers_workspace_idx').on(table.workspaceId, table.id)],
);

/**
 * One row of a workflow's timeline (round 4 §2.3, FR-CHAT-001..003). `content` is `Part[]`, so a
 * file in a message is an artifact reference and never bytes (FR-MM-004, BR-02). The timeline is
 * derived from persisted events, so it replays identically after a reconnect.
 */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    workflowId: text('workflow_id').notNull(),
    runId: text('run_id'),
    nodeId: text('node_id'),
    nodeRunId: text('node_run_id'),
    type: text('type').notNull(),
    /** JSON `Part[]`. */
    content: text('content').notNull(),
    at: text('at').notNull(),
  },
  (table) => [
    index('messages_workflow_idx').on(table.workspaceId, table.workflowId, table.id),
    index('messages_run_idx').on(table.workspaceId, table.runId, table.id),
    index('messages_node_idx').on(table.workspaceId, table.nodeId, table.id),
  ],
);

/**
 * A direct-chat conversation with one agent (round 4 §2.3, FR-CHAT-004). A thread uses the agent's
 * model, instructions, context policy and tools but never reads or writes `runs`/`node_runs`
 * (FR-CHAT-005), which is why its turns are `chat_messages`, a different id space from `node_runs`.
 */
export const chatThreads = sqliteTable(
  'chat_threads',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    nodeId: text('node_id').notNull(),
    title: text('title').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('chat_threads_node_idx').on(table.workspaceId, table.nodeId, table.id)],
);

/**
 * One turn of a direct chat (round 4 §2.3, FR-CHAT-006/008). `verdicts` are `ChatVerdict[]` (no
 * `nodeRunId`, because the thread touches no node run), `usage` is present only on an agent reply,
 * and `content` is `Part[]` as everywhere else.
 */
export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    threadId: text('thread_id').notNull(),
    role: text('role').notNull(),
    /** JSON `Part[]`. */
    content: text('content').notNull(),
    /** JSON `ChatVerdict[]`. */
    verdicts: text('verdicts').notNull(),
    /** JSON `Usage`, null on a user turn. */
    usage: text('usage'),
    at: text('at').notNull(),
  },
  (table) => [index('chat_messages_thread_idx').on(table.workspaceId, table.threadId, table.id)],
);

/* -------------------------------------------------------------------------- */
/* Round 5 (Arch §15.3, §21.3): knowledge, memory, summary cache               */
/* -------------------------------------------------------------------------- */

/**
 * A knowledge base (round 5 §2.1, FR-RAG-001). There is deliberately no `document_count` or
 * `chunk_count` column: both are counted from the rows on every read, so they cannot drift. The
 * embedder is fixed for the base's life — vectors from two models do not compare (D235).
 */
export const knowledgeBases = sqliteTable(
  'knowledge_bases',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id').notNull(),
    name: text('name').notNull(),
    embeddingProviderId: text('embedding_provider_id').notNull(),
    embeddingModelId: text('embedding_model_id').notNull(),
    chunkSize: integer('chunk_size').notNull(),
    chunkOverlap: integer('chunk_overlap').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('knowledge_bases_project_idx').on(table.workspaceId, table.projectId, table.id),
  ],
);

/** A document in the ingestion pipeline (§2.1, FR-RAG-002, 003, Arch §21.3). */
export const kbDocuments = sqliteTable(
  'kb_documents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    knowledgeBaseId: text('knowledge_base_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    status: text('status').notNull(),
    chunkCount: integer('chunk_count').notNull(),
    /** Why ingestion failed, in words a user can act on; null once it is ready again (D72). */
    error: text('error'),
    ingestedAt: text('ingested_at'),
    /** JSON `KbDocumentVerdict[]`, null until the ingestion-time checks have run. */
    verdicts: text('verdicts'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('kb_documents_kb_idx').on(table.workspaceId, table.knowledgeBaseId, table.id),
    index('kb_documents_status_idx').on(table.workspaceId, table.status, table.id),
  ],
);

/**
 * One indexed piece of a document (§2.1). `seq` is an INTEGER PRIMARY KEY — the table's rowid —
 * so it survives VACUUM, which the FTS5 external-content index keyed by that rowid depends on.
 * `id` is the chunk's ULID, the one the envelope and the node run's `sources` carry.
 */
export const kbChunks = sqliteTable(
  'kb_chunks',
  {
    seq: integer('seq').primaryKey(),
    id: text('id').notNull().unique(),
    workspaceId: text('workspace_id').notNull(),
    knowledgeBaseId: text('knowledge_base_id').notNull(),
    documentId: text('document_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    tokens: integer('tokens').notNull(),
    source: text('source').notNull(),
    /** JSON `string[]`, outermost heading first. */
    headings: text('headings').notNull(),
  },
  (table) => [
    index('kb_chunks_document_idx').on(table.workspaceId, table.documentId, table.ordinal),
    index('kb_chunks_kb_idx').on(table.workspaceId, table.knowledgeBaseId),
  ],
);

/**
 * Every embedding, as little-endian Float32 bytes (F8). The table of record for vectors: the
 * sqlite-vec index (`indexes.ts`) is rebuilt from it, and the scan fallback reads it directly.
 */
export const kbVectors = sqliteTable(
  'kb_vectors',
  {
    chunkId: text('chunk_id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    knowledgeBaseId: text('knowledge_base_id').notNull(),
    documentId: text('document_id').notNull(),
    dims: integer('dims').notNull(),
    embedding: blob('embedding', { mode: 'buffer' }).notNull(),
  },
  (table) => [
    index('kb_vectors_kb_idx').on(table.workspaceId, table.knowledgeBaseId),
    index('kb_vectors_document_idx').on(table.workspaceId, table.documentId),
  ],
);

/** Long-term agent memory (round 5 §2.2, FR-MEM-001..004, Arch §12.8): one value per key per node. */
export const agentMemory = sqliteTable(
  'agent_memory',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    nodeId: text('node_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** When the entry last went into an envelope. */
    lastUsedAt: text('last_used_at'),
  },
  (table) => [
    unique().on(table.workspaceId, table.nodeId, table.key),
    index('agent_memory_node_idx').on(table.workspaceId, table.nodeId, table.createdAt, table.id),
  ],
);

/**
 * Model summaries by content hash (§2.5, FR-RAG-010): 30 days from creation, pruned to 5,000 rows
 * per workspace, least recently used first.
 */
export const summaryCache = sqliteTable(
  'summary_cache',
  {
    workspaceId: text('workspace_id').notNull(),
    key: text('key').notNull(),
    summary: text('summary').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.key] }),
    index('summary_cache_lru_idx').on(table.workspaceId, table.lastUsedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* ACE parity P0 (D267–D271): tasks and what belongs to them                   */
/* -------------------------------------------------------------------------- */

/**
 * A task on a project's board. The schema's first foreign keys: it goes with its project, and a
 * deleted workflow leaves it without a team or planner (`ON DELETE SET NULL`).
 */
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Per project, from 1. */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    brief: text('brief').notNull(),
    type: text('type').notNull(),
    stage: text('stage').notNull(),
    state: text('state').notNull(),
    stateReason: text('state_reason'),
    outcome: text('outcome'),
    finishLine: text('finish_line').notNull(),
    automation: text('automation').notNull(),
    priority: text('priority').notNull(),
    /** JSON `string[]`. */
    labels: text('labels').notNull(),
    workflowId: text('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
    plannerWorkflowId: text('planner_workflow_id').references(() => workflows.id, {
      onDelete: 'set null',
    }),
    plan: text('plan').notNull(),
    acceptance: text('acceptance').notNull(),
    runChecks: integer('run_checks', { mode: 'boolean' }).notNull(),
    paused: integer('paused', { mode: 'boolean' }).notNull(),
    pendingRequest: text('pending_request'),
    /** ACE parity P1 (D275): JSON `TaskDeliverable`, NULL when the task has none. */
    deliverable: text('deliverable'),
    /** ACE parity P1: JSON `TaskSource`, NULL for a task made in the New task dialog. */
    source: text('source'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
  },
  (table) => [
    unique().on(table.workspaceId, table.projectId, table.number),
    index('tasks_project_idx').on(table.workspaceId, table.projectId),
    index('tasks_state_idx').on(table.workspaceId, table.state),
  ],
);

/** A task's Git worktree (D269): at most one per task. */
export const taskWorkspaces = sqliteTable('task_workspaces', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  taskId: text('task_id')
    .notNull()
    .unique()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  repoPath: text('repo_path').notNull(),
  path: text('path').notNull(),
  branch: text('branch').notNull(),
  baseBranch: text('base_branch').notNull(),
  baseSha: text('base_sha').notNull(),
  headSha: text('head_sha').notNull(),
  status: text('status').notNull(),
  error: text('error'),
  /** ACE parity P1 (D276): JSON — the pull request as GitHub last reported it. */
  pullRequest: text('pull_request'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** The plan and work runs a task made, numbered per task. `workflowId` and `runId` are history. */
export const taskExecutions = sqliteTable(
  'task_executions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    sequence: integer('sequence').notNull(),
    workflowId: text('workflow_id').notNull(),
    runId: text('run_id'),
    status: text('status').notNull(),
    request: text('request').notNull(),
    summary: text('summary'),
    commitSha: text('commit_sha'),
    changedFiles: integer('changed_files'),
    error: text('error'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
  },
  (table) => [
    unique().on(table.taskId, table.sequence),
    index('task_executions_run_idx').on(table.workspaceId, table.runId),
  ],
);

/** One run of one project check command in a task's workspace (D271). */
export const taskChecks = sqliteTable(
  'task_checks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    executionId: text('execution_id'),
    name: text('name').notNull(),
    command: text('command').notNull(),
    status: text('status').notNull(),
    exitCode: integer('exit_code'),
    output: text('output').notNull(),
    durationMs: integer('duration_ms').notNull(),
    headSha: text('head_sha').notNull(),
    at: text('at').notNull(),
  },
  (table) => [index('task_checks_task_idx').on(table.taskId, table.at)],
);

export const taskReviews = sqliteTable(
  'task_reviews',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    decision: text('decision').notNull(),
    note: text('note'),
    headSha: text('head_sha'),
    at: text('at').notNull(),
  },
  (table) => [index('task_reviews_task_idx').on(table.taskId, table.at)],
);

export const taskDeliveries = sqliteTable(
  'task_deliveries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    destination: text('destination').notNull(),
    detail: text('detail'),
    sha: text('sha'),
    url: text('url'),
    at: text('at').notNull(),
  },
  (table) => [index('task_deliveries_task_idx').on(table.taskId, table.at)],
);

/**
 * A task's activity feed, append-only. `seq` is the rowid, so it keeps the insertion order through
 * VACUUM, and AUTOINCREMENT never hands one out twice.
 */
export const taskActivity = sqliteTable(
  'task_activity',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    workspaceId: text('workspace_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    executionId: text('execution_id'),
    runId: text('run_id'),
    at: text('at').notNull(),
  },
  (table) => [index('task_activity_task_idx').on(table.taskId, table.seq)],
);

/* -------------------------------------------------------------------------- */
/* ACE parity P1 (D277): task schedules                                        */
/* -------------------------------------------------------------------------- */

/**
 * When a task starts by itself: at most one schedule per task, gone with its task. `trigger` is the
 * JSON `TaskTrigger`; `kind` and `afterTaskId` repeat what the scheduler queries by.
 */
export const taskSchedules = sqliteTable(
  'task_schedules',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .unique()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    kind: text('kind').notNull(),
    afterTaskId: text('after_task_id'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    nextRunAt: text('next_run_at'),
    lastRunAt: text('last_run_at'),
    lastTaskId: text('last_task_id'),
    skipped: integer('skipped').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('task_schedules_enabled_idx').on(table.workspaceId, table.enabled),
    index('task_schedules_after_task_idx').on(table.workspaceId, table.afterTaskId),
  ],
);
