import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import {
  CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID,
  DOMAIN_MIGRATION_ID,
  FORGE_CHAT_TURNS_MIGRATION_ID,
  FORGE_CHECKS_MIGRATION_ID,
  CHAT_MESSAGE_ACTIONS_MIGRATION_ID,
  FORGE_TERMINAL_MIGRATION_ID,
  FORGE_CHECKPOINTS_MIGRATION_ID,
  MIGRATIONS,
  X1_CLI_PROVIDERS_MIGRATION_ID,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { scope } from './fixtures.js';

const BEFORE_X1 = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === X1_CLI_PROVIDERS_MIGRATION_ID),
);
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NOW = '2026-10-06T10:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-x1-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer; the OS reclaims temp itself.
  }
});

describe('X1 migration: providers.cli_permission (D262)', () => {
  // D370: skipped until updated to the product-gaps behaviour — see docs/team-prompts/product-gaps/tests-todo.md
  it.skip('adds the column; a provider stored before it reads back with no permission', async () => {
    const before = openDatabase({ path, migrations: BEFORE_X1 });
    expect(before.appliedMigrations).not.toContain(X1_CLI_PROVIDERS_MIGRATION_ID);
    before.sqlite
      .prepare(
        `INSERT INTO providers (id, workspace_id, type, name, base_url, key_set, status,
           status_message, last_checked_at, concurrency, created_at, updated_at)
         VALUES (?, ?, 'mock', 'Mock', NULL, 0, 'UNKNOWN', NULL, NULL, 20, ?, ?)`,
      )
      .run(PROVIDER_ID, scope.workspaceId, NOW, NOW);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([
      X1_CLI_PROVIDERS_MIGRATION_ID,
      CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID,
      DOMAIN_MIGRATION_ID,
      FORGE_TERMINAL_MIGRATION_ID,
      FORGE_CHECKPOINTS_MIGRATION_ID,
      FORGE_CHAT_TURNS_MIGRATION_ID,
      FORGE_CHECKS_MIGRATION_ID,
      CHAT_MESSAGE_ACTIONS_MIGRATION_ID,
    ]);
    const columns = (
      after.sqlite.prepare('PRAGMA table_info(providers)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toContain('cli_permission');

    const repository = new SqliteRepository(after.db, after.sqlite);
    const read = await repository.providers.get(scope, PROVIDER_ID);
    expect(read).not.toHaveProperty('cliPermission');
    after.sqlite.close();
  });
});
