import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatMessage, Model } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import {
  CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID,
  DOMAIN_MIGRATION_ID,
  FORGE_CHAT_TURNS_MIGRATION_ID,
  FORGE_CHECKS_MIGRATION_ID,
  FORGE_TERMINAL_MIGRATION_ID,
  FORGE_CHECKPOINTS_MIGRATION_ID,
  MIGRATIONS,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { scope } from './fixtures.js';

const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID),
);
const NOW = '2026-10-09T10:00:00.000Z';
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const THREAD_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0THRD';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NODE';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN0A';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-sessions-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer; the OS reclaims temp itself.
  }
});

const columnsOf = (sqlite: ReturnType<typeof openDatabase>['sqlite'], table: string): string[] =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('D285/D286 migration: chat turns from runs and failures, discovered model details', () => {
  it('adds the columns; rows stored before it read back exactly as they did', async () => {
    const before = openDatabase({ path, migrations: BEFORE });
    before.sqlite
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, thread_id, role, content, verdicts, usage, at)
         VALUES ('01JBXQ8Z9KQ4R7N2VWXYZ0MSG1', ?, ?, 'user', '[{"type":"text","text":"hi"}]', '[]', NULL, ?)`,
      )
      .run(scope.workspaceId, THREAD_ID, NOW);
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([
      CHAT_SESSIONS_CLI_MODELS_MIGRATION_ID,
      DOMAIN_MIGRATION_ID,
      FORGE_TERMINAL_MIGRATION_ID,
      FORGE_CHECKPOINTS_MIGRATION_ID,
      FORGE_CHAT_TURNS_MIGRATION_ID,
      FORGE_CHECKS_MIGRATION_ID,
    ]);
    expect(columnsOf(after.sqlite, 'chat_messages')).toEqual(
      expect.arrayContaining(['run_id', 'error', 'model_id']),
    );
    expect(columnsOf(after.sqlite, 'models')).toEqual(
      expect.arrayContaining(['description', 'resolved_model_id', 'unavailable_reason']),
    );

    const repository = new SqliteRepository(after.db, after.sqlite);
    const [old] = await repository.chatMessages.listByThread(scope, THREAD_ID);
    expect(old).toEqual({
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0MSG1',
      threadId: THREAD_ID,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      verdicts: [],
      at: NOW,
    });
    after.sqlite.close();
  });

  it('round-trips a run turn, a failed turn and the model that answered', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    await repository.chatThreads.create(scope, {
      id: THREAD_ID,
      nodeId: NODE_ID,
      title: 'Write a haiku',
      createdAt: NOW,
      updatedAt: NOW,
    });

    const answered: ChatMessage = {
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0MSG2',
      threadId: THREAD_ID,
      role: 'agent',
      content: [{ type: 'text', text: 'Soft rain' }],
      verdicts: [],
      usage: { tokensIn: 4, tokensOut: 2, costUsd: 0 },
      at: NOW,
      runId: RUN_ID,
      modelId: 'claude-opus-5-5',
    };
    const failed: ChatMessage = {
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0MSG3',
      threadId: THREAD_ID,
      role: 'agent',
      content: [{ type: 'text', text: 'Claude Code is not signed in.' }],
      verdicts: [],
      at: NOW,
      error: {
        kind: 'auth',
        code: 'cli_not_signed_in',
        message: 'Claude Code is not signed in.',
        retryable: false,
      },
    };
    await repository.chatMessages.append(scope, answered);
    await repository.chatMessages.append(scope, failed);

    expect(await repository.chatMessages.listByThread(scope, THREAD_ID)).toEqual([
      answered,
      failed,
    ]);
    db.sqlite.close();
  });

  it('round-trips what a provider said about a model: description, resolution and unavailability', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const base = {
      providerId: PROVIDER_ID,
      inputTypes: ['text'],
      outputTypes: ['text'],
      contextWindow: 200_000,
      supportsTools: false,
      supportsJson: false,
      source: 'discovered',
      lastCheckedAt: NOW,
    } as const;
    const alias: Model = {
      ...base,
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
      modelId: 'opus',
      displayName: 'Opus 5.5',
      available: true,
      description: 'For complex work and everyday tasks',
      resolvedModelId: 'claude-opus-5-5',
      inputTypes: ['text'],
      outputTypes: ['text'],
    };
    const tooNew: Model = {
      ...base,
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE2',
      modelId: 'claude-sonnet-5-5',
      displayName: 'Sonnet 5.5',
      available: false,
      unavailableReason: 'Update Claude Code to use this model',
      inputTypes: ['text'],
      outputTypes: ['text'],
    };
    await repository.models.replaceForProvider(scope, PROVIDER_ID, [alias, tooNew]);

    const listed = await repository.models.list(scope, {
      providerId: PROVIDER_ID,
    });
    expect(listed).toEqual(expect.arrayContaining([alias, tooNew]));
    db.sqlite.close();
  });
});
