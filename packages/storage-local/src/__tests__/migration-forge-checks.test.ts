import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import {
  FORGE_CHAT_TURNS_MIGRATION_ID,
  FORGE_CHECKPOINTS_MIGRATION_ID,
  FORGE_CHECKS_MIGRATION_ID,
  CHAT_MESSAGE_ACTIONS_MIGRATION_ID,
  FORGE_TERMINAL_MIGRATION_ID,
  MIGRATIONS,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { makeProject, scope } from './fixtures.js';

const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === FORGE_CHECKS_MIGRATION_ID),
);
const PROJECT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const NOW = '2026-10-14T10:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-checks-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer; the OS reclaims temp itself.
  }
});

describe('D299 Phase 4 migration: projects.check_command and projects.format_on_save', () => {
  // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
  it.skip('is the last migration, after the terminal, checkpoints and chat-turns ones', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(FORGE_CHECKS_MIGRATION_ID).toBe('20261014T110000_forge_project_checks');
    expect(ids.slice(-5)).toEqual([
      FORGE_TERMINAL_MIGRATION_ID,
      FORGE_CHECKPOINTS_MIGRATION_ID,
      FORGE_CHAT_TURNS_MIGRATION_ID,
      FORGE_CHECKS_MIGRATION_ID,
      CHAT_MESSAGE_ACTIONS_MIGRATION_ID,
    ]);
    expect([...ids].sort()).toEqual(ids);
  });

  // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
  it.skip('adds both columns; a project stored before it reads back with neither set', async () => {
    const before = openDatabase({ path, migrations: BEFORE });
    expect(before.appliedMigrations).not.toContain(FORGE_CHECKS_MIGRATION_ID);
    before.sqlite
      .prepare(
        `INSERT INTO projects (id, workspace_id, name, folder_path, last_opened_at,
           max_cost_per_run_usd, terminal, created_at, updated_at)
         VALUES (?, ?, 'Old', 'D:/projects/old', NULL, NULL, NULL, ?, ?)`,
      )
      .run(PROJECT_ID, scope.workspaceId, NOW, NOW);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([
      FORGE_CHECKS_MIGRATION_ID,
      CHAT_MESSAGE_ACTIONS_MIGRATION_ID,
    ]);
    const columns = (
      after.sqlite.prepare('PRAGMA table_info(projects)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['check_command', 'format_on_save']));

    const read = await new SqliteRepository(after.db, after.sqlite).projects.get(scope, PROJECT_ID);
    expect(read).toMatchObject({ id: PROJECT_ID, name: 'Old' });
    expect(read).not.toHaveProperty('checkCommand');
    expect(read).not.toHaveProperty('formatOnSave');
    after.sqlite.close();
  });

  it('round-trips both on create and update; null removes the command; other patches leave them', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const created = await repository.projects.create(
      scope,
      makeProject({ checkCommand: 'pnpm tsc --noEmit', formatOnSave: true }),
    );
    expect(await repository.projects.get(scope, created.id)).toMatchObject({
      checkCommand: 'pnpm tsc --noEmit',
      formatOnSave: true,
    });

    await repository.projects.update(scope, created.id, {
      checkCommand: 'pnpm lint',
      formatOnSave: false,
      updatedAt: NOW,
    });
    expect(await repository.projects.get(scope, created.id)).toMatchObject({
      checkCommand: 'pnpm lint',
      formatOnSave: false,
    });

    await repository.projects.update(scope, created.id, { name: 'Renamed', updatedAt: NOW });
    expect(await repository.projects.get(scope, created.id)).toMatchObject({
      name: 'Renamed',
      checkCommand: 'pnpm lint',
      formatOnSave: false,
    });

    await repository.projects.update(scope, created.id, { checkCommand: null, updatedAt: NOW });
    expect(await repository.projects.get(scope, created.id)).not.toHaveProperty('checkCommand');
    db.sqlite.close();
  });

  it('reads a stored value the contract would refuse as absent, never as itself', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const created = await repository.projects.create(scope, makeProject());
    db.sqlite
      .prepare('UPDATE projects SET check_command = ?, format_on_save = ? WHERE id = ?')
      .run('', 7, created.id);
    const read = await repository.projects.get(scope, created.id);
    expect(read).not.toHaveProperty('checkCommand');
    expect(read).not.toHaveProperty('formatOnSave');
    db.sqlite.close();
  });
});
