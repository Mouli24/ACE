import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getTableColumns } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import {
  MIGRATIONS,
  PARITY_P0_MIGRATION_ID,
  PARITY_P1_SECRETS_MIGRATION_ID,
  PARITY_P1_SKILLS_MIGRATION_ID,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { secrets } from '../schema.js';
import { scope } from './fixtures.js';

/**
 * The ACE parity P1 secrets migration (D274): one table of names, descriptions and project scopes,
 * with no column for a value. Opened twice, as the P0 test does: once with the chain before it, so
 * an existing install really predates the table, then with the whole chain.
 */

const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === PARITY_P1_SECRETS_MIGRATION_ID),
);

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-migration-p1-secrets-'));
  path = join(dir, 'ace.sqlite');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering handle on Windows; the OS reclaims the temp directory anyway
  }
});

const tableNames = (sqlite: ReturnType<typeof openDatabase>['sqlite']): string[] =>
  (
    sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string;
    }[]
  ).map((row) => row.name);

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

const columnsOf = (sqlite: ReturnType<typeof openDatabase>['sqlite']): ColumnInfo[] =>
  sqlite.prepare('PRAGMA table_info(secrets)').all() as ColumnInfo[];

describe('D274 the secrets migration applies on a P0 database and is recorded', () => {
  it('adds the secrets table, and an existing install reads no secrets', async () => {
    const before = openDatabase({ path, migrations: BEFORE });
    expect(before.appliedMigrations).not.toContain(PARITY_P1_SECRETS_MIGRATION_ID);
    expect(before.appliedMigrations).toContain(PARITY_P0_MIGRATION_ID);
    expect(tableNames(before.sqlite)).not.toContain('secrets');
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual(
      MIGRATIONS.slice(BEFORE.length).map((migration) => migration.id),
    );
    expect(after.appliedMigrations[0]).toBe(PARITY_P1_SECRETS_MIGRATION_ID);
    expect(tableNames(after.sqlite)).toContain('secrets');
    expect(
      after.sqlite
        .prepare('SELECT id FROM _ace_migrations WHERE id = ?')
        .get(PARITY_P1_SECRETS_MIGRATION_ID),
    ).toEqual({ id: PARITY_P1_SECRETS_MIGRATION_ID });

    const repository = new SqliteRepository(after.db, after.sqlite);
    expect(await repository.secrets.list(scope)).toEqual([]);
    after.sqlite.close();
  });

  it('keys a row by workspace and name, every column required, and no value column', () => {
    const opened = openDatabase({ path });
    const columns = columnsOf(opened.sqlite);
    expect(columns.map((column) => column.name)).toEqual([
      'workspace_id',
      'name',
      'description',
      'project_ids',
      'created_at',
      'updated_at',
    ]);
    expect(columns.every((column) => column.notnull === 1 && column.type === 'TEXT')).toBe(true);
    expect(
      columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
    ).toEqual(['workspace_id', 'name']);
    expect(columns.some((column) => /value|secret/i.test(column.name))).toBe(false);
    opened.sqlite.close();
  });

  it('declares exactly the columns the Drizzle mirror names', () => {
    const opened = openDatabase({ path });
    const sqlColumns = columnsOf(opened.sqlite).map((column) => column.name);
    const mirrored = Object.values(getTableColumns(secrets)).map((column) => column.name);
    expect(sqlColumns.sort()).toEqual(mirrored.sort());
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
  it('comes right after the P1 skills migration, and the chain stays sorted', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids.indexOf(PARITY_P1_SECRETS_MIGRATION_ID)).toBe(
      ids.indexOf(PARITY_P1_SKILLS_MIGRATION_ID) + 1,
    );
    expect([...ids].sort()).toEqual(ids);
    expect(PARITY_P1_SECRETS_MIGRATION_ID).toBe('20261007T100100_parity_p1_secrets');
  });
});
