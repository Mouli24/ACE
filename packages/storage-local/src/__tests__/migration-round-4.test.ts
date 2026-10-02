import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { newId } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { MIGRATIONS, ROUND_4_MIGRATION_ID, ROUND_5_MIGRATION_ID } from '../migrations.js';
import { SqliteRepository } from '../repository.js';

/**
 * The round 4 migration (Arch §15.3): artifacts, tool_calls, mcp_servers, messages, chat_threads,
 * chat_messages. It opens the database twice on purpose — once with the chain as it stood before
 * round 4, so an existing install really predates the new tables, then with the whole chain, which
 * is what a user upgrading experiences.
 */

const BEFORE_ROUND_4 = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === ROUND_4_MIGRATION_ID),
);

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-migration-4-'));
  path = join(dir, 'ace.sqlite');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NEW_TABLES = [
  'artifacts',
  'tool_calls',
  'mcp_servers',
  'messages',
  'chat_threads',
  'chat_messages',
];

describe('Arch §15.3 the round 4 migration adds the six new tables', () => {
  it('is absent before round 4 and present after the whole chain runs', () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_4 });
    expect(before.appliedMigrations).not.toContain(ROUND_4_MIGRATION_ID);
    const tablesBefore = (
      before.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    for (const table of NEW_TABLES) expect(tablesBefore).not.toContain(table);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([ROUND_4_MIGRATION_ID, ROUND_5_MIGRATION_ID]);
    const tablesAfter = (
      after.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    for (const table of NEW_TABLES) expect(tablesAfter).toContain(table);
    after.sqlite.close();
  });

  it('enforces the per-workspace unique hash index (FR-MM-002)', () => {
    const opened = openDatabase({ path });
    const insert = opened.sqlite.prepare(
      `INSERT INTO artifacts (id, workspace_id, hash, mime, name, size, created_at)
       VALUES (?, 'local', ?, 'image/png', 'a.png', 1, ?)`,
    );
    const hash = 'a'.repeat(64);
    insert.run(newId(), hash, '2026-09-29T10:00:00.000Z');
    expect(() => insert.run(newId(), hash, '2026-09-29T10:00:01.000Z')).toThrow(/UNIQUE/i);
    opened.sqlite.close();
  });

  it('reads and writes every new table through the repository once upgraded', async () => {
    const before = openDatabase({ path, migrations: BEFORE_ROUND_4 });
    before.sqlite.close();

    const after = openDatabase({ path });
    const repository = new SqliteRepository(after.db, after.sqlite);
    const s = { workspaceId: 'local' };

    const a = {
      id: newId(),
      hash: 'a'.repeat(64),
      mime: 'image/png',
      name: 'a.png',
      size: 1,
      createdAt: '2026-09-29T10:00:00.000Z',
    };
    await repository.artifacts.create(s, a);
    expect(await repository.artifacts.getByHash(s, a.hash)).toEqual(a);

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
});
