import { LOCAL_SCOPE, newId, type Repository, type TaskRecord } from '@ace/engine';
import type { Edge, Node, Project, TaskActivity, Workflow } from '@ace/contracts';
import type BetterSqlite3 from 'better-sqlite3';

import { buildDefaultPolicy } from '../default-policy.js';

/** Narrowed node types, so spreading a fixture keeps `kind` discriminating. */
export type InputNode = Extract<Node, { kind: 'input' }>;
export type OutputNode = Extract<Node, { kind: 'output' }>;

export const scope = LOCAL_SCOPE;

export const NOW = '2026-09-21T10:00:00.000Z';

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: newId(),
    name: 'Demo',
    folderPath: 'D:/projects/demo',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Stores a project in a database migrated only part way — from round 3 to X1 — as an install from
 * before the ACE parity P0 migration did. The repository's insert names the Build-settings columns
 * that migration adds, so on an older chain the row goes in with the columns that chain has; the
 * default policy still goes through the repository, whose table is older than that migration.
 */
export async function createProjectBeforeP0(
  sqlite: BetterSqlite3.Database,
  repository: Repository,
  project: Project,
): Promise<void> {
  sqlite
    .prepare(
      `INSERT INTO projects (id, workspace_id, name, folder_path, last_opened_at,
         max_cost_per_run_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      scope.workspaceId,
      project.name,
      project.folderPath,
      project.lastOpenedAt ?? null,
      project.maxCostPerRunUsd ?? null,
      project.createdAt,
      project.updatedAt,
    );
  await repository.guardrailPolicies.create(
    scope,
    buildDefaultPolicy(project.id, project.createdAt),
  );
}

export function makeWorkflow(projectId: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: newId(),
    projectId,
    name: 'Flow 1',
    version: 0,
    formatVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeOutputNode(workflowId: string, id = newId()): OutputNode {
  return {
    id,
    workflowId,
    kind: 'output',
    name: 'Output',
    position: { x: 0, y: 0 },
    inputs: [{ id: `${id}:in:text`, name: 'text', dataType: 'text', multi: false }],
    outputs: [],
    config: {},
  };
}

export function makeInputNode(workflowId: string, id = newId()): InputNode {
  return {
    id,
    workflowId,
    kind: 'input',
    name: 'Input',
    position: { x: 10, y: 20 },
    inputs: [],
    outputs: [{ id: `${id}:out:text`, name: 'text', dataType: 'text', multi: true }],
    config: { artifactIds: [], outputTypes: ['text'] },
  };
}

export function makeEdge(workflowId: string, from: Node, to: Node): Edge {
  return {
    id: newId(),
    workflowId,
    kind: 'data',
    from: { nodeId: from.id, portId: `${from.id}:out:text` },
    to: { nodeId: to.id, portId: `${to.id}:in:text` },
  };
}

/** A task as the store keeps it (ACE parity P0): every optional field absent. */
export function makeTask(projectId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: newId(),
    projectId,
    number: 1,
    title: 'Add a health check',
    brief: 'Expose GET /health answering 200.',
    type: 'app',
    stage: 'inbox',
    state: 'idle',
    finishLine: 'review',
    automation: 'assisted',
    priority: 'normal',
    labels: [],
    plan: '',
    acceptance: '',
    runChecks: true,
    paused: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeTaskActivity(
  taskId: string,
  overrides: Partial<TaskActivity> = {},
): TaskActivity {
  return {
    id: newId(),
    taskId,
    kind: 'created',
    message: 'Task created.',
    at: NOW,
    ...overrides,
  };
}
