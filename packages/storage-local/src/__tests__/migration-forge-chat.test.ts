import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatMessage } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import {
  FORGE_CHAT_TURNS_MIGRATION_ID,
  FORGE_CHECKPOINTS_MIGRATION_ID,
  FORGE_CHECKS_MIGRATION_ID,
  FORGE_TERMINAL_MIGRATION_ID,
  MIGRATIONS,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { scope } from './fixtures.js';

const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === FORGE_CHAT_TURNS_MIGRATION_ID),
);
const THREAD_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0THR1';
const MESSAGE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0CMS1';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const CHECKPOINT_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0CKP1';
const NOW = '2026-10-14T10:00:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-chat-turns-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer; the OS reclaims temp itself.
  }
});

describe('D302 migration: chat_messages speaker, activity and checkpoint', () => {
  it('follows the terminal trust level and the checkpoints table; the project checks follow it', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(FORGE_CHAT_TURNS_MIGRATION_ID).toBe('20261014T105000_forge_chat_turns');
    expect(ids.slice(-4)).toEqual([
      FORGE_TERMINAL_MIGRATION_ID,
      FORGE_CHECKPOINTS_MIGRATION_ID,
      FORGE_CHAT_TURNS_MIGRATION_ID,
      FORGE_CHECKS_MIGRATION_ID,
    ]);
    expect([...ids].sort()).toEqual(ids);
  });

  it('adds the columns; a turn stored before reads back without them', async () => {
    const before = openDatabase({ path, migrations: BEFORE });
    before.sqlite
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, thread_id, role, content, verdicts, at)
         VALUES (?, ?, ?, 'agent', '[{"type":"text","text":"old"}]', '[]', ?)`,
      )
      .run(MESSAGE_ID, scope.workspaceId, THREAD_ID, NOW);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([
      FORGE_CHAT_TURNS_MIGRATION_ID,
      FORGE_CHECKS_MIGRATION_ID,
    ]);
    const columns = (
      after.sqlite.prepare('PRAGMA table_info(chat_messages)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining(['speaker_node_id', 'activity', 'checkpoint_id']),
    );

    const [read] = await new SqliteRepository(after.db, after.sqlite).chatMessages.listByThread(
      scope,
      THREAD_ID,
    );
    expect(read).toMatchObject({ id: MESSAGE_ID, role: 'agent' });
    expect(read).not.toHaveProperty('speakerNodeId');
    expect(read).not.toHaveProperty('activity');
    expect(read).not.toHaveProperty('checkpointId');
    after.sqlite.close();
  });

  it('round-trips who spoke, what it did and its checkpoint', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const message: ChatMessage = {
      id: MESSAGE_ID,
      threadId: THREAD_ID,
      role: 'agent',
      content: [{ type: 'text', text: 'Fixed it.' }],
      verdicts: [],
      at: NOW,
      speakerNodeId: NODE_ID,
      activity: [
        { kind: 'read', tool: 'read_file', path: 'src/a.ts', summary: 'Read src/a.ts' },
        { kind: 'edit', tool: 'edit_file', path: 'src/a.ts', summary: 'Edited src/a.ts' },
      ],
      checkpointId: CHECKPOINT_ID,
    };
    await repository.chatMessages.append(scope, message);
    expect(await repository.chatMessages.listByThread(scope, THREAD_ID)).toEqual([message]);
    db.sqlite.close();
  });
});
