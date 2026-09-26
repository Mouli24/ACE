import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
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
