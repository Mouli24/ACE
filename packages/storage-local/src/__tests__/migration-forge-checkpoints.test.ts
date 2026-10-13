import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Checkpoint } from '@ace/contracts';
import type { StoredCheckpoint } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import {
  FORGE_CHECKPOINTS_MIGRATION_ID,
  FORGE_TERMINAL_MIGRATION_ID,
  MIGRATIONS,
} from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { scope } from './fixtures.js';

const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === FORGE_CHECKPOINTS_MIGRATION_ID),
);
const PROJECT = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const OTHER_PROJECT = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJD';
const RUN = '01JBXQ8Z9KQ4R7N2VWXYZ0RN0A';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-checkpoints-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer; the OS reclaims temp itself.
  }
});

const checkpoint = (
  id: string,
  createdAt: string,
  extra: Partial<Checkpoint> = {},
): Checkpoint => ({
  id,
  projectId: PROJECT,
  kind: 'run',
  runId: RUN,
  status: 'recording',
  files: [],
  skipped: [],
  createdAt,
  updatedAt: createdAt,
  ...extra,
});

const stored = (cp: Checkpoint, beforeRef = 'a'.repeat(40)): StoredCheckpoint => ({
  checkpoint: cp,
  beforeRef,
});

describe('D300 migration: the checkpoints table', () => {
  it('is the last migration, after the terminal’s, with the id the plan fixed', () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(FORGE_CHECKPOINTS_MIGRATION_ID).toBe('20261014T100000_forge_checkpoints');
    expect(ids.slice(-2)).toEqual([FORGE_TERMINAL_MIGRATION_ID, FORGE_CHECKPOINTS_MIGRATION_ID]);
    expect([...ids].sort()).toEqual(ids);
  });

  it('creates the table and its index on a database from before it', () => {
    openDatabase({ path, migrations: BEFORE }).sqlite.close();
    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([FORGE_CHECKPOINTS_MIGRATION_ID]);
    const columns = (
      after.sqlite.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'workspace_id',
      'project_id',
      'kind',
      'thread_id',
      'message_id',
      'run_id',
      'node_id',
      'status',
      'files_json',
      'skipped_json',
      'before_ref',
      'after_ref',
      'error',
      'created_at',
      'updated_at',
    ]);
    const indexes = (
      after.sqlite.prepare('PRAGMA index_list(checkpoints)').all() as { name: string }[]
    ).map((index) => index.name);
    expect(indexes).toContain('checkpoints_project_idx');
    after.sqlite.close();
  });
});

describe('D300 the checkpoint repository', () => {
  it('round-trips a checkpoint with its refs, and keeps the refs off the checkpoint itself', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const cp = checkpoint('01JBXQ8Z9KQ4R7N2VWXYZ0CKP1', '2026-10-14T10:00:00.000Z', {
      kind: 'chat',
      runId: undefined,
      threadId: '01JBXQ8Z9KQ4R7N2VWXYZ0THRD',
      messageId: '01JBXQ8Z9KQ4R7N2VWXYZ0MSG1',
      nodeId: '01JBXQ8Z9KQ4R7N2VWXYZ0NDE1',
      skipped: ['big.bin'],
    });
    delete (cp as { runId?: string }).runId;
    await repository.checkpoints.insert(scope, stored(cp));

    const read = await repository.checkpoints.get(scope, cp.id);
    expect(read).toEqual({ checkpoint: cp, beforeRef: 'a'.repeat(40) });
    expect(read?.checkpoint).not.toHaveProperty('beforeRef');
    db.sqlite.close();
  });

  it('updates status, files and the after ref; an error is set and cleared', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const cp = checkpoint('01JBXQ8Z9KQ4R7N2VWXYZ0CKP1', '2026-10-14T10:00:00.000Z');
    await repository.checkpoints.insert(scope, stored(cp));
    const files = [
      {
        path: 'a.ts',
        change: 'modified' as const,
        additions: 2,
        deletions: 1,
        binary: false,
        state: 'pending' as const,
      },
    ];
    const updated = await repository.checkpoints.update(scope, cp.id, {
      status: 'pending',
      files,
      afterRef: 'b'.repeat(40),
      error: 'x',
      updatedAt: '2026-10-14T10:05:00.000Z',
    });
    expect(updated).toEqual({
      checkpoint: {
        ...cp,
        status: 'pending',
        files,
        error: 'x',
        updatedAt: '2026-10-14T10:05:00.000Z',
      },
      beforeRef: 'a'.repeat(40),
      afterRef: 'b'.repeat(40),
    });
    const cleared = await repository.checkpoints.update(scope, cp.id, {
      error: null,
      updatedAt: '2026-10-14T10:06:00.000Z',
    });
    expect(cleared?.checkpoint).not.toHaveProperty('error');
    expect(await repository.checkpoints.update(scope, 'missing', { updatedAt: 'x' })).toBeNull();
    db.sqlite.close();
  });

  it('lists a project’s checkpoints newest first, and every one in a status oldest first', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const first = checkpoint('01JBXQ8Z9KQ4R7N2VWXYZ0CKP1', '2026-10-14T10:00:00.000Z');
    const second = checkpoint('01JBXQ8Z9KQ4R7N2VWXYZ0CKP2', '2026-10-14T11:00:00.000Z', {
      status: 'pending',
    });
    const elsewhere = checkpoint('01JBXQ8Z9KQ4R7N2VWXYZ0CKP3', '2026-10-14T12:00:00.000Z', {
      projectId: OTHER_PROJECT,
    });
    for (const cp of [first, second, elsewhere])
      await repository.checkpoints.insert(scope, stored(cp));

    const listed = await repository.checkpoints.listByProject(scope, PROJECT);
    expect(listed.map((row) => row.checkpoint.id)).toEqual([second.id, first.id]);
    const recording = await repository.checkpoints.listByStatus(scope, 'recording');
    expect(recording.map((row) => row.checkpoint.id)).toEqual([first.id, elsewhere.id]);

    expect(await repository.checkpoints.delete(scope, first.id)).toBe(true);
    expect(await repository.checkpoints.delete(scope, first.id)).toBe(false);
    expect(await repository.checkpoints.get(scope, first.id)).toBeNull();
    db.sqlite.close();
  });
});
