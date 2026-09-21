import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  appliedMigrations,
  applyMigrations,
  MIGRATIONS,
  pendingMigrations,
  type Migration,
} from './migrations.js';
import * as schema from './schema.js';

export interface OpenDatabaseOptions {
  /** Path to the SQLite file. Its directory is created if missing. */
  path: string;
  /** Overridable so a migration chain can be exercised; defaults to the shipped list. */
  migrations?: readonly Migration[];
}

export interface OpenDatabase {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: BetterSqlite3.Database;
  /** The backup written before migrations ran, when there was an existing schema to protect. */
  backupPath?: string;
  appliedMigrations: string[];
}

/** Copies the database file, returning where it went (NFR-REL-03, TC-NFR-007). */
export function backupDatabase(path: string): string | undefined {
  if (!existsSync(path)) return undefined;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(dirname(path), `ace-backup-${stamp}.sqlite`);
  copyFileSync(path, backupPath);
  return backupPath;
}

/**
 * Whether opening this database is about to change an existing schema.
 *
 * A brand new file has nothing to lose, and a database already up to date is not being touched —
 * only the case of "some migrations applied, more to run" needs a backup. Checking the migration
 * ledger rather than the file size matters because simply opening the file and creating the ledger
 * already writes pages, so an empty-file test would never be true.
 */
export function needsBackup(
  sqlite: BetterSqlite3.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): boolean {
  return appliedMigrations(sqlite).size > 0 && pendingMigrations(sqlite, migrations).length > 0;
}

/**
 * Opens the local database and brings it up to date.
 *
 * WAL keeps a reader from blocking the writer, and `foreign_keys` is on so a stray reference fails
 * loudly. The backup happens before the first migration statement, never after.
 */
export function openDatabase({ path, migrations }: OpenDatabaseOptions): OpenDatabase {
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new BetterSqlite3(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const backupPath = needsBackup(sqlite, migrations) ? backupDatabase(path) : undefined;
  const applied = applyMigrations(sqlite, migrations);

  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    ...(backupPath === undefined ? {} : { backupPath }),
    appliedMigrations: applied,
  };
}
