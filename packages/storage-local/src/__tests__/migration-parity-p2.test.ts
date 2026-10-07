import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';
import { getTableColumns, type Table } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { MIGRATIONS, PARITY_P1_MIGRATION_ID, PARITY_P2_MIGRATION_ID } from '../migrations.js';
import { projectNotes, responsibilities, suggestions } from '../schema.js';

/**
 * The ACE parity P2 migration (D280, D281): responsibilities, suggestions and team notes. Opened
 * on a P1 database, then with the whole chain, as the P0 and P1 tests do.
 */

const BEFORE_P2 = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === PARITY_P2_MIGRATION_ID),
);

const TABLES: [name: string, mirror: Table][] = [
  ['responsibilities', responsibilities],
  ['suggestions', suggestions],
  ['project_notes', projectNotes],
];

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-migration-p2-'));
  path = join(dir, 'ace.sqlite');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering handle on Windows; the OS reclaims the temp directory anyway
  }
});

const tableNames = (sqlite: BetterSqlite3.Database): string[] =>
  (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string;
    }[]
  ).map((row) => row.name);

const columnNames = (sqlite: BetterSqlite3.Database, table: string): string[] =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );

const foreignKeys = (sqlite: BetterSqlite3.Database, table: string) =>
  (
    sqlite.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      table: string;
      from: string;
      on_delete: string;
    }[]
  )
    .map(({ table: parent, from, on_delete }) => ({ parent, from, onDelete: on_delete }))
    .sort((a, b) => a.from.localeCompare(b.from));

describe('D280/D281 the P2 migration', () => {
  it('adds the three tables on a P1 database and records itself', () => {
    const before = openDatabase({ path, migrations: BEFORE_P2 });
    expect(before.appliedMigrations).toContain(PARITY_P1_MIGRATION_ID);
    for (const [table] of TABLES) expect(tableNames(before.sqlite)).not.toContain(table);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([PARITY_P2_MIGRATION_ID]);
    for (const [table] of TABLES) expect(tableNames(after.sqlite)).toContain(table);
    after.sqlite.close();
  });

  it('declares exactly the columns the Drizzle mirror names', () => {
    const opened = openDatabase({ path });
    for (const [table, mirror] of TABLES) {
      const mirrored = Object.values(getTableColumns(mirror)).map((column) => column.name);
      expect(columnNames(opened.sqlite, table).sort(), table).toEqual(mirrored.sort());
    }
    opened.sqlite.close();
  });

  it('ties every row to its project, and a suggestion to its responsibility', () => {
    const opened = openDatabase({ path });
    expect(foreignKeys(opened.sqlite, 'responsibilities')).toEqual([
      { parent: 'projects', from: 'project_id', onDelete: 'CASCADE' },
    ]);
    expect(foreignKeys(opened.sqlite, 'suggestions')).toEqual([
      { parent: 'projects', from: 'project_id', onDelete: 'CASCADE' },
      { parent: 'responsibilities', from: 'responsibility_id', onDelete: 'CASCADE' },
    ]);
    expect(foreignKeys(opened.sqlite, 'project_notes')).toEqual([
      { parent: 'projects', from: 'project_id', onDelete: 'CASCADE' },
    ]);
    opened.sqlite.close();
  });

  it('is the latest migration, right after P1, and the chain stays sorted', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(MIGRATIONS.at(-1)?.id).toBe(PARITY_P2_MIGRATION_ID);
    expect(ids.indexOf(PARITY_P2_MIGRATION_ID)).toBe(ids.indexOf(PARITY_P1_MIGRATION_ID) + 1);
    expect([...ids].sort()).toEqual(ids);
  });
});
