import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newId } from '@ace/engine';
import type BetterSqlite3 from 'better-sqlite3';
import { getTableColumns, type Table } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { MIGRATIONS, PARITY_P0_MIGRATION_ID, PARITY_P1_MIGRATION_ID } from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { projects, tasks, taskSchedules, taskWorkspaces } from '../schema.js';
import { createProjectBeforeP0, makeProject, makeTask, NOW, scope } from './fixtures.js';

/**
 * The ACE parity P1 migration (D275–D278): a task's deliverable and source, a workspace's pull
 * request, a project's preview command and URL, and the task schedules table.
 *
 * It opens the database twice on purpose, as the P0 test does: once with the chain as it stood
 * before P1, so an existing install really has P0's tables without the new columns, then with the
 * whole chain.
 */

const BEFORE_P1 = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === PARITY_P1_MIGRATION_ID),
);

const NEW_COLUMNS: [table: string, columns: string[]][] = [
  ['tasks', ['deliverable', 'source']],
  ['task_workspaces', ['pull_request']],
  ['projects', ['preview_command', 'preview_url']],
];

/** Each table P1 touches and its hand-kept Drizzle mirror, which must name the same columns. */
const MIRRORED: [name: string, mirror: Table][] = [
  ['task_schedules', taskSchedules],
  ['tasks', tasks],
  ['task_workspaces', taskWorkspaces],
  ['projects', projects],
];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-migration-p1-'));
  path = join(dir, 'ace.sqlite');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering handle on Windows; the OS reclaims the temp directory anyway
  }
});

function tableNames(sqlite: BetterSqlite3.Database): string[] {
  return (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

function columnNames(sqlite: BetterSqlite3.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

function foreignKeysOf(sqlite: BetterSqlite3.Database, table: string) {
  return (
    sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }[]
  ).map(({ table: parent, from, to, on_delete }) => ({ parent, from, to, onDelete: on_delete }));
}

function indexesOf(sqlite: BetterSqlite3.Database, table: string) {
  const list = sqlite.prepare(`PRAGMA index_list(${table})`).all() as {
    name: string;
    unique: number;
  }[];
  return list.map(({ name, unique }) => ({
    unique: unique === 1,
    columns: (sqlite.prepare(`PRAGMA index_info("${name}")`).all() as { name: string }[]).map(
      (column) => column.name,
    ),
  }));
}

describe('D275–D278 the P1 migration applies on a P0 database and is recorded', () => {
  it('adds the five columns and the task_schedules table', () => {
    const before = openDatabase({ path, migrations: BEFORE_P1 });
    expect(before.appliedMigrations).toContain(PARITY_P0_MIGRATION_ID);
    expect(before.appliedMigrations).not.toContain(PARITY_P1_MIGRATION_ID);
    expect(tableNames(before.sqlite)).not.toContain('task_schedules');
    for (const [table, columns] of NEW_COLUMNS) {
      for (const column of columns) expect(columnNames(before.sqlite, table)).not.toContain(column);
    }
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([PARITY_P1_MIGRATION_ID]);
    expect(tableNames(after.sqlite)).toContain('task_schedules');
    for (const [table, columns] of NEW_COLUMNS) {
      expect(columnNames(after.sqlite, table), table).toEqual(expect.arrayContaining(columns));
    }
    expect(
      after.sqlite
        .prepare('SELECT id FROM _ace_migrations WHERE id = ?')
        .get(PARITY_P1_MIGRATION_ID),
    ).toEqual({ id: PARITY_P1_MIGRATION_ID });
    after.sqlite.close();
  });

  it('declares exactly the columns the Drizzle mirror names', () => {
    const opened = openDatabase({ path });
    for (const [table, mirror] of MIRRORED) {
      const mirrored = Object.values(getTableColumns(mirror)).map((column) => column.name);
      expect(columnNames(opened.sqlite, table).sort(), table).toEqual(mirrored.sort());
    }
    opened.sqlite.close();
  });

  it('keeps every project, task and workspace written before it, read back exactly as it was', async () => {
    const before = openDatabase({ path, migrations: BEFORE_P1 });
    const project = makeProject({ setupCommand: 'pnpm install' });
    await createProjectBeforeP0(
      before.sqlite,
      new SqliteRepository(before.db, before.sqlite),
      project,
    );
    before.sqlite
      .prepare('UPDATE projects SET setup_command = ? WHERE id = ?')
      .run('pnpm install', project.id);
    const task = makeTask(project.id, { labels: ['old'] });
    before.sqlite
      .prepare(
        `INSERT INTO tasks (id, workspace_id, project_id, number, title, brief, type, stage, state,
           finish_line, automation, priority, labels, plan, acceptance, run_checks, paused,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        scope.workspaceId,
        project.id,
        task.number,
        task.title,
        task.brief,
        task.type,
        task.stage,
        task.state,
        task.finishLine,
        task.automation,
        task.priority,
        JSON.stringify(task.labels),
        task.plan,
        task.acceptance,
        task.runChecks ? 1 : 0,
        task.paused ? 1 : 0,
        task.createdAt,
        task.updatedAt,
      );
    const workspace = {
      id: newId(),
      taskId: task.id,
      repoPath: 'D:/projects/demo',
      path: 'D:/ace-data/workspaces/task',
      branch: 'ace/task-1',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'ready' as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    before.sqlite
      .prepare(
        `INSERT INTO task_workspaces (id, workspace_id, task_id, repo_path, path, branch,
           base_branch, base_sha, head_sha, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.id,
        scope.workspaceId,
        task.id,
        workspace.repoPath,
        workspace.path,
        workspace.branch,
        workspace.baseBranch,
        workspace.baseSha,
        workspace.headSha,
        workspace.status,
        workspace.createdAt,
        workspace.updatedAt,
      );
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(
      after.sqlite
        .prepare('SELECT preview_command, preview_url FROM projects WHERE id = ?')
        .get(project.id),
    ).toEqual({ preview_command: null, preview_url: null });
    expect(
      after.sqlite.prepare('SELECT deliverable, source FROM tasks WHERE id = ?').get(task.id),
    ).toEqual({ deliverable: null, source: null });

    const repository = new SqliteRepository(after.db, after.sqlite);
    expect(await repository.projects.get(scope, project.id)).toEqual(project);
    expect(await repository.tasks.get(scope, task.id)).toEqual(task);
    expect(await repository.taskWorkspaces.getByTask(scope, task.id)).toEqual(workspace);
    expect(after.sqlite.prepare('SELECT count(*) AS n FROM task_schedules').get()).toEqual({
      n: 0,
    });
    after.sqlite.close();
  });

  it('applies exactly once, so reopening an up-to-date database changes nothing', () => {
    const first = openDatabase({ path });
    expect(first.appliedMigrations).toEqual(MIGRATIONS.map((migration) => migration.id));
    first.sqlite.close();

    const again = openDatabase({ path });
    expect(again.appliedMigrations).toEqual([]);
    again.sqlite.close();
  });

  it('is the latest migration, right after P0, and the chain stays sorted', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(MIGRATIONS.at(-1)?.id).toBe(PARITY_P1_MIGRATION_ID);
    expect(ids.indexOf(PARITY_P1_MIGRATION_ID)).toBe(ids.indexOf(PARITY_P0_MIGRATION_ID) + 1);
    expect([...ids].sort()).toEqual(ids);
    expect(PARITY_P1_MIGRATION_ID).toBe('20261007T100200_parity_p1_tasks');
  });
});

describe('D277 the task_schedules table carries its keys and indexes', () => {
  it('ties a schedule to its task (cascade), and only to its task', () => {
    const opened = openDatabase({ path });
    expect(foreignKeysOf(opened.sqlite, 'task_schedules')).toEqual([
      { parent: 'tasks', from: 'task_id', to: 'id', onDelete: 'CASCADE' },
    ]);
    opened.sqlite.close();
  });

  it('keeps one schedule per task, and indexes the two reads the scheduler makes', () => {
    const opened = openDatabase({ path });
    expect(indexesOf(opened.sqlite, 'task_schedules')).toEqual(
      expect.arrayContaining([
        { unique: true, columns: ['task_id'] },
        { unique: false, columns: ['workspace_id', 'enabled'] },
        { unique: false, columns: ['workspace_id', 'after_task_id'] },
      ]),
    );
    opened.sqlite.close();
  });
});
