import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
