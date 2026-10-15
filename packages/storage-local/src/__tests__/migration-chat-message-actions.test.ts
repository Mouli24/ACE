import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatMessage } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { CHAT_MESSAGE_ACTIONS_MIGRATION_ID, MIGRATIONS } from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { scope } from './fixtures.js';

const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === CHAT_MESSAGE_ACTIONS_MIGRATION_ID),
);
const THREAD_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0THR1';
const OTHER_THREAD_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0THR2';
const MESSAGE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0CMS1';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const NOW = '2026-10-15T10:00:00.000Z';
const LATER = '2026-10-15T10:05:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-chat-actions-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer; the OS reclaims temp itself.
  }
});

describe('PG-1.6 migration: chat_messages superseded_at and deleted_at [D352]', () => {
  it('is the last migration and sorts after every earlier one', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids.at(-1)).toBe(CHAT_MESSAGE_ACTIONS_MIGRATION_ID);
    expect([...ids].sort()).toEqual(ids);
  });

  it('adds both columns; a turn stored before reads back with neither set', async () => {
    const before = openDatabase({ path, migrations: BEFORE });
    before.sqlite
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, thread_id, role, content, verdicts, at)
         VALUES (?, ?, ?, 'user', '[{"type":"text","text":"old"}]', '[]', ?)`,
      )
      .run(MESSAGE_ID, scope.workspaceId, THREAD_ID, NOW);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([CHAT_MESSAGE_ACTIONS_MIGRATION_ID]);
    const columns = (
      after.sqlite.prepare('PRAGMA table_info(chat_messages)').all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['superseded_at', 'deleted_at']));

    const [read] = await new SqliteRepository(after.db, after.sqlite).chatMessages.listByThread(
      scope,
      THREAD_ID,
    );
    expect(read).not.toHaveProperty('supersededAt');
    expect(read).not.toHaveProperty('deletedAt');
    after.sqlite.close();
  });

  it('mark sets each flag, keeps the rest of the turn, and answers null for no such message', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const message: ChatMessage = {
      id: MESSAGE_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
      verdicts: [],
      at: NOW,
    };
    await repository.chatMessages.append(scope, message);

    const superseded = await repository.chatMessages.mark(scope, MESSAGE_ID, {
      supersededAt: LATER,
    });
    expect(superseded).toEqual({ ...message, supersededAt: LATER });
    const deleted = await repository.chatMessages.mark(scope, MESSAGE_ID, {
      deletedAt: LATER,
    });
    expect(deleted).toEqual({
      ...message,
      supersededAt: LATER,
      deletedAt: LATER,
    });
    expect(await repository.chatMessages.listByThread(scope, THREAD_ID)).toEqual([deleted]);
    expect(await repository.chatMessages.mark(scope, NODE_ID, { deletedAt: LATER })).toBeNull();
    db.sqlite.close();
  });

  it('lists every thread of the workspace, oldest first (PG-1.5 startup scan)', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    for (const id of [OTHER_THREAD_ID, THREAD_ID]) {
      await repository.chatThreads.create(scope, {
        id,
        nodeId: NODE_ID,
        title: 't',
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    expect((await repository.chatThreads.list(scope)).map((thread) => thread.id)).toEqual([
      THREAD_ID,
      OTHER_THREAD_ID,
    ]);
    db.sqlite.close();
  });
});
