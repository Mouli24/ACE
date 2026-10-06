import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';
import { getTableColumns, type Table } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import {
  MIGRATIONS,
  PARITY_P0_MIGRATION_ID,
  X1_CLI_PROVIDERS_MIGRATION_ID,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import {
  projects,
  taskActivity,
  taskChecks,
  taskDeliveries,
  taskExecutions,
  taskReviews,
  tasks,
  taskWorkspaces,
} from '../schema.js';
import { createProjectBeforeP0, makeProject, scope } from './fixtures.js';

/**
 * The ACE parity P0 migration (D267–D271): a project's four Build-settings columns, and the seven
 * task tables with the schema's first foreign keys.
 *
 * Like the round 5 test, it opens the database twice on purpose: once with the chain as it stood
 * before P0, so an existing install really predates the new tables, then with the whole chain.
 */

const BEFORE_P0 = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === PARITY_P0_MIGRATION_ID),
);

/** Each new table and its hand-kept Drizzle mirror, which must name the same columns. */
const NEW_TABLES: [name: string, mirror: Table][] = [
  ['tasks', tasks],
  ['task_workspaces', taskWorkspaces],
  ['task_executions', taskExecutions],
  ['task_checks', taskChecks],
  ['task_reviews', taskReviews],
  ['task_deliveries', taskDeliveries],
  ['task_activity', taskActivity],
];

const PROJECT_COLUMNS = ['paused', 'build_capacity', 'check_commands', 'setup_command'];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-migration-p0-'));
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

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columnsOf(sqlite: BetterSqlite3.Database, table: string): ColumnInfo[] {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

interface ForeignKeyInfo {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

function foreignKeysOf(sqlite: BetterSqlite3.Database, table: string) {
  return (sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as ForeignKeyInfo[]).map(
    ({ table: parent, from, to, on_delete }) => ({ parent, from, to, onDelete: on_delete }),
  );
}

/** Every index of a table, by the columns it covers and whether it is unique. */
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

describe('D267–D271 the P0 migration applies on an X1 database and is recorded', () => {
  it('adds the project Build-settings columns and the seven task tables', () => {
    const before = openDatabase({ path, migrations: BEFORE_P0 });
    expect(before.appliedMigrations).not.toContain(PARITY_P0_MIGRATION_ID);
    for (const [table] of NEW_TABLES) expect(tableNames(before.sqlite)).not.toContain(table);
    const projectColumnsBefore = columnsOf(before.sqlite, 'projects').map((column) => column.name);
    for (const column of PROJECT_COLUMNS) expect(projectColumnsBefore).not.toContain(column);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([PARITY_P0_MIGRATION_ID]);
    for (const [table] of NEW_TABLES) expect(tableNames(after.sqlite)).toContain(table);

    const projectColumns = columnsOf(after.sqlite, 'projects');
    expect(projectColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(PROJECT_COLUMNS),
    );
    expect(projectColumns.find((column) => column.name === 'paused')).toMatchObject({
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '0',
    });

    const ledger = after.sqlite
      .prepare('SELECT id FROM _ace_migrations WHERE id = ?')
      .get(PARITY_P0_MIGRATION_ID);
    expect(ledger).toEqual({ id: PARITY_P0_MIGRATION_ID });
    after.sqlite.close();
  });

  it('declares exactly the columns the Drizzle mirror names', () => {
    const opened = openDatabase({ path });
    for (const [table, mirror] of [...NEW_TABLES, ['projects', projects] as const]) {
      const sqlColumns = columnsOf(opened.sqlite, table).map((column) => column.name);
      const mirrored = Object.values(getTableColumns(mirror)).map((column) => column.name);
      expect(sqlColumns.sort(), table).toEqual(mirrored.sort());
    }
    opened.sqlite.close();
  });

  it('keeps every project written before it: not paused, and read back exactly as it was', async () => {
    const before = openDatabase({ path, migrations: BEFORE_P0 });
    const project = makeProject({ maxCostPerRunUsd: 2 });
    await createProjectBeforeP0(
      before.sqlite,
      new SqliteRepository(before.db, before.sqlite),
      project,
    );
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(
      after.sqlite
        .prepare(
          `SELECT paused, build_capacity, check_commands, setup_command FROM projects WHERE id = ?`,
        )
        .get(project.id),
    ).toEqual({ paused: 0, build_capacity: null, check_commands: null, setup_command: null });

    const repository = new SqliteRepository(after.db, after.sqlite);
    expect(await repository.projects.get(scope, project.id)).toEqual(project);
    expect(await repository.tasks.listByProject(scope, project.id)).toEqual([]);
    expect(await repository.tasks.nextNumber(scope, project.id)).toBe(1);
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

  it('is the latest migration, right after X1, and the chain stays sorted', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(MIGRATIONS.at(-1)?.id).toBe(PARITY_P0_MIGRATION_ID);
    expect(ids.indexOf(PARITY_P0_MIGRATION_ID)).toBe(
      ids.indexOf(X1_CLI_PROVIDERS_MIGRATION_ID) + 1,
    );
    expect([...ids].sort()).toEqual(ids);
    expect(PARITY_P0_MIGRATION_ID).toBe('20261006T180000_parity_p0_tasks');
  });
});

describe('D268 the task tables carry their keys and indexes', () => {
  it('ties a task to its project (cascade) and to its team and planner (set null)', () => {
    const opened = openDatabase({ path });
    expect(foreignKeysOf(opened.sqlite, 'tasks')).toEqual(
      expect.arrayContaining([
        { parent: 'projects', from: 'project_id', to: 'id', onDelete: 'CASCADE' },
        { parent: 'workflows', from: 'workflow_id', to: 'id', onDelete: 'SET NULL' },
        { parent: 'workflows', from: 'planner_workflow_id', to: 'id', onDelete: 'SET NULL' },
      ]),
    );
    expect(foreignKeysOf(opened.sqlite, 'tasks')).toHaveLength(3);
    opened.sqlite.close();
  });

  it('ties every child row to its task, and only to its task', () => {
    const opened = openDatabase({ path });
    for (const [table] of NEW_TABLES.filter(([name]) => name !== 'tasks')) {
      expect(foreignKeysOf(opened.sqlite, table), table).toEqual([
        { parent: 'tasks', from: 'task_id', to: 'id', onDelete: 'CASCADE' },
      ]);
    }
    opened.sqlite.close();
  });

  it('indexes the reads the repositories make and the uniqueness the contract states', () => {
    const opened = openDatabase({ path });
    const { sqlite } = opened;
    expect(indexesOf(sqlite, 'tasks')).toEqual(
      expect.arrayContaining([
        { unique: true, columns: ['workspace_id', 'project_id', 'number'] },
        { unique: false, columns: ['workspace_id', 'project_id'] },
        { unique: false, columns: ['workspace_id', 'state'] },
      ]),
    );
    expect(indexesOf(sqlite, 'task_workspaces')).toEqual(
      expect.arrayContaining([{ unique: true, columns: ['task_id'] }]),
    );
    expect(indexesOf(sqlite, 'task_executions')).toEqual(
      expect.arrayContaining([
        { unique: true, columns: ['task_id', 'sequence'] },
        { unique: false, columns: ['workspace_id', 'run_id'] },
      ]),
    );
    for (const table of ['task_checks', 'task_reviews', 'task_deliveries']) {
      expect(indexesOf(sqlite, table), table).toEqual(
        expect.arrayContaining([{ unique: false, columns: ['task_id', 'at'] }]),
      );
    }
    expect(indexesOf(sqlite, 'task_activity')).toEqual(
      expect.arrayContaining([
        { unique: true, columns: ['id'] },
        { unique: false, columns: ['task_id', 'seq'] },
      ]),
    );
    opened.sqlite.close();
  });

  it('numbers activity with an AUTOINCREMENT rowid, so the feed order survives VACUUM', () => {
    const opened = openDatabase({ path });
    const { sql } = opened.sqlite
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_activity'`)
      .get() as { sql: string };
    expect(sql).toMatch(/seq\s+INTEGER PRIMARY KEY AUTOINCREMENT/);
    opened.sqlite.close();
  });
});
