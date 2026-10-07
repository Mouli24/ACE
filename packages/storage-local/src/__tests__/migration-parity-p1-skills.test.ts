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
  PARITY_P1_SKILLS_MIGRATION_ID,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { bundles, skills } from '../schema.js';
import { createProjectBeforeP0, makeProject, scope } from './fixtures.js';

/**
 * The ACE parity P1 skills migration (D272, D273): the `skills` and `bundles` tables.
 *
 * Like the P0 test, it opens the database twice on purpose: once with the chain as it stood before
 * this migration, so an existing install really predates the tables, then with the whole chain.
 */

const BEFORE_SKILLS = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === PARITY_P1_SKILLS_MIGRATION_ID),
);

/** Each new table and its hand-kept Drizzle mirror, which must name the same columns. */
const NEW_TABLES: [name: string, mirror: Table][] = [
  ['skills', skills],
  ['bundles', bundles],
];

const AT = '2026-10-07T10:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-migration-p1-skills-'));
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

function columnsOf(sqlite: BetterSqlite3.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

function indexSql(sqlite: BetterSqlite3.Database, name: string): string | undefined {
  return (
    sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name) as
      { sql: string } | undefined
  )?.sql;
}

const insertSkill = (sqlite: BetterSqlite3.Database, id: string, workspace: string, name: string) =>
  sqlite
    .prepare(
      `INSERT INTO skills (id, workspace_id, name, description, instructions, version, source,
         bundle_id, created_at, updated_at)
       VALUES (?, ?, ?, '', 'Do the work well.', 1, 'user', NULL, ?, ?)`,
    )
    .run(id, workspace, name, AT, AT);

describe('D272 D273 the skills migration applies on a P0 database and is recorded', () => {
  it('adds the skills and bundles tables, and nothing else changes', async () => {
    const before = openDatabase({ path, migrations: BEFORE_SKILLS });
    expect(before.appliedMigrations).not.toContain(PARITY_P1_SKILLS_MIGRATION_ID);
    for (const [table] of NEW_TABLES) expect(tableNames(before.sqlite)).not.toContain(table);
    const project = makeProject();
    // Written as an install before P0 would hold it: the repository now writes later columns too.
    await createProjectBeforeP0(
      before.sqlite,
      new SqliteRepository(before.db, before.sqlite),
      project,
    );
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual(
      MIGRATIONS.slice(BEFORE_SKILLS.length).map((migration) => migration.id),
    );
    expect(after.appliedMigrations[0]).toBe(PARITY_P1_SKILLS_MIGRATION_ID);
    for (const [table] of NEW_TABLES) expect(tableNames(after.sqlite)).toContain(table);

    const ledger = after.sqlite
      .prepare('SELECT id FROM _ace_migrations WHERE id = ?')
      .get(PARITY_P1_SKILLS_MIGRATION_ID);
    expect(ledger).toEqual({ id: PARITY_P1_SKILLS_MIGRATION_ID });

    // An existing install keeps its rows, and starts with no skill and no bundle.
    const repository = new SqliteRepository(after.db, after.sqlite);
    expect(await repository.projects.get(scope, project.id)).toEqual(project);
    expect(await repository.skills.list(scope)).toEqual([]);
    expect(await repository.bundles.list(scope)).toEqual([]);
    after.sqlite.close();
  });

  it('declares exactly the columns the Drizzle mirror names', () => {
    const opened = openDatabase({ path });
    for (const [table, mirror] of NEW_TABLES) {
      const mirrored = Object.values(getTableColumns(mirror)).map((column) => column.name);
      expect(columnsOf(opened.sqlite, table).sort(), table).toEqual(mirrored.sort());
    }
    opened.sqlite.close();
  });

  it('applies exactly once, so reopening an up-to-date database changes nothing', () => {
    const first = openDatabase({ path });
    expect(first.appliedMigrations).toEqual(MIGRATIONS.map((migration) => migration.id));
    first.sqlite.close();

    const again = openDatabase({ path });
    expect(again.appliedMigrations).toEqual([]);
    again.sqlite.close();
  });

  // Which migration is the latest is asserted by the newest migration's own test (P2's).
  it('comes right after P0, and the chain stays sorted', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids.indexOf(PARITY_P1_SKILLS_MIGRATION_ID)).toBe(
      ids.indexOf(PARITY_P0_MIGRATION_ID) + 1,
    );
    expect([...ids].sort()).toEqual(ids);
    expect(PARITY_P1_SKILLS_MIGRATION_ID).toBe('20261007T100000_parity_p1_skills');
  });
});

describe('D272 a skill name is unique per workspace, whatever its case', () => {
  it('indexes the lower-cased name under the workspace', () => {
    const opened = openDatabase({ path });
    expect(indexSql(opened.sqlite, 'skills_name_idx')).toMatch(
      /CREATE UNIQUE INDEX skills_name_idx ON skills \(workspace_id, lower\(name\)\)/,
    );
    expect(indexSql(opened.sqlite, 'bundles_workspace_idx')).toMatch(
      /ON bundles \(workspace_id, created_at\)/,
    );
    opened.sqlite.close();
  });

  it('refuses a second "test first" in one workspace and allows it in another', () => {
    const opened = openDatabase({ path });
    insertSkill(opened.sqlite, '01K6SKTEST000000000000000A', scope.workspaceId, 'Test first');
    expect(() =>
      insertSkill(opened.sqlite, '01K6SKTEST000000000000000B', scope.workspaceId, 'test FIRST'),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insertSkill(opened.sqlite, '01K6SKTEST000000000000000C', 'other', 'Test first'),
    ).not.toThrow();
    opened.sqlite.close();
  });
});
