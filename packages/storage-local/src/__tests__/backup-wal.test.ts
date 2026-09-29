import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type OpenDatabase } from '../db.js';
import { MIGRATIONS, type Migration } from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { makeProject, scope } from './fixtures.js';

/**
 * NFR-REL-03, TC-NFR-007: the backup taken before a migration holds every committed row.
 *
 * The database runs in WAL mode, so a commit can sit in `ace.sqlite-wal` until a checkpoint. A
 * process that dies without closing — a closed console or a killed service, on Windows — leaves it
 * there, and a backup that copies only the main file then holds none of it: on a developer's
 * machine `ace.sqlite` was 4 KB, `ace.sqlite-wal` 1.2 MB, and both `ace-backup-*.sqlite` 4 KB.
 */

/** One pending migration, so reopening the database takes the backup path for real. */
const LATER: Migration = {
  id: '20260929T090000_add_probe',
  up: 'CREATE TABLE probe (id TEXT PRIMARY KEY);',
};

let dir: string;
let handles: { close(): unknown }[];

function open(path: string, migrations: readonly Migration[]): OpenDatabase {
  const db = openDatabase({ path, migrations });
  handles.push(db.sqlite);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-backup-wal-'));
  handles = [];
});

afterEach(() => {
  // Windows refuses to remove a directory while a SQLite handle (or its -wal/-shm) is open.
  for (const handle of handles.reverse()) {
    try {
      handle.close();
    } catch {
      // already closed by the test
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering handle on Windows; the OS reclaims the temp directory anyway
  }
});

describe('TC-NFR-007 NFR-REL-03 the pre-migration backup holds what is still in the WAL', () => {
  it('backs up a project committed by a connection that was never closed', async () => {
    const path = join(dir, 'ace.sqlite');
    // Left open, as a process killed without close() leaves it: the row sits in the -wal file.
    const crashed = open(path, MIGRATIONS);
    const project = makeProject({ name: 'Survives the backup' });
    await new SqliteRepository(crashed.db, crashed.sqlite).projects.create(scope, project);
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);

    const migrated = open(path, [...MIGRATIONS, LATER]);

    expect(migrated.backupPath).toBeDefined();
    const backupPath = migrated.backupPath as string;
    expect(existsSync(backupPath)).toBe(true);
    // Read the copy as a file on its own: no migrations, no writes, nothing of the live WAL.
    const backup = new BetterSqlite3(backupPath, { readonly: true, fileMustExist: true });
    handles.push(backup);
    const rows = backup.prepare('SELECT id, name FROM projects').all();

    expect(rows).toEqual([{ id: project.id, name: 'Survives the backup' }]);
  });

  it('still backs up the schema as it was, before the pending migration ran', () => {
    const path = join(dir, 'ace.sqlite');
    open(path, MIGRATIONS);

    const migrated = open(path, [...MIGRATIONS, LATER]);
    const backup = new BetterSqlite3(migrated.backupPath as string, { readonly: true });
    handles.push(backup);
    const probe = backup
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe'")
      .get();

    expect(probe).toBeUndefined();
    expect(
      backup
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
        .get(),
    ).toEqual({ name: 'projects' });
  });
});
