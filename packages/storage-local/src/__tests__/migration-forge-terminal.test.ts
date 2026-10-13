import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import {
  DOMAIN_MIGRATION_ID,
  FORGE_CHAT_TURNS_MIGRATION_ID,
  FORGE_TERMINAL_MIGRATION_ID,
  MIGRATIONS,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { makeProject, scope } from './fixtures.js';

const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === FORGE_TERMINAL_MIGRATION_ID),
);
const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const NOW = '2026-10-10T10:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-terminal-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer; the OS reclaims temp itself.
  }
});

describe('D301 migration: projects.terminal', () => {
  it('sorts after the Domain migration, and only D302’s chat turns follow it', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(FORGE_TERMINAL_MIGRATION_ID).toBe('20261013T120000_forge_terminal_trust');
    expect(ids.slice(-3)).toEqual([
      DOMAIN_MIGRATION_ID,
      FORGE_TERMINAL_MIGRATION_ID,
      FORGE_CHAT_TURNS_MIGRATION_ID,
    ]);
    expect([...ids].sort()).toEqual(ids);
  });

  it('adds the column; a project stored before it reads back with no trust level, which means on', async () => {
    const before = openDatabase({ path, migrations: BEFORE });
    expect(before.appliedMigrations).not.toContain(FORGE_TERMINAL_MIGRATION_ID);
    before.sqlite
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, folder_path, last_opened_at,
           max_cost_per_run_usd, created_at, updated_at)
         VALUES (?, ?, 'Old', 'D:/projects/old', NULL, NULL, ?, ?)`,
      )
      .run(PROJECT_ID, scope.workspaceId, NOW, NOW);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([
      FORGE_TERMINAL_MIGRATION_ID,
      FORGE_CHAT_TURNS_MIGRATION_ID,
    ]);
    const columns = (
      after.sqlite.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toContain('terminal');

    const read = await new SqliteRepository(after.db, after.sqlite).projects.get(scope, PROJECT_ID);
    expect(read).toMatchObject({ id: PROJECT_ID, name: 'Old' });
    expect(read).not.toHaveProperty('terminal');
    after.sqlite.close();
  });

  it('writes the trust level on create and on update, and a patch without it leaves it alone', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const created = await repository.projects.create(scope, makeProject({ terminal: 'scripts' }));
    expect((await repository.projects.get(scope, created.id))?.terminal).toBe('scripts');

    await repository.projects.update(scope, created.id, { terminal: 'off', updatedAt: NOW });
    expect((await repository.projects.get(scope, created.id))?.terminal).toBe('off');

    await repository.projects.update(scope, created.id, { name: 'Renamed', updatedAt: NOW });
    expect(await repository.projects.get(scope, created.id)).toMatchObject({
      name: 'Renamed',
      terminal: 'off',
    });
    db.sqlite.close();
  });

  it('reads a stored value the contract does not name as no trust level, never as itself', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const created = await repository.projects.create(scope, makeProject());
    db.sqlite
      .prepare('UPDATE projects SET terminal = ? WHERE id = ?')
      .run('everything', created.id);
    expect(await repository.projects.get(scope, created.id)).not.toHaveProperty('terminal');
    db.sqlite.close();
  });
});
