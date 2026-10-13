import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isCheckpointConflictError, isCheckpointUnavailableError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHECKPOINT_FILE_MAX_BYTES, createGitCheckpointStore } from './git-store.js';

/*
 * D300 fix round 1 (C1, I1, I2): a revert deletes a file only on proof the agent created it, and a
 * snapshot is honest about what it could not capture. Every test runs against the real store.
 */

const hasGit = spawnSync('git', ['--version']).status === 0;
const PROJECT = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';

let dataDir: string;
let root: string;

const write = (path: string, content: string | Buffer): void => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
};
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-cp-data-'));
  root = mkdtempSync(join(tmpdir(), 'ace-cp-root-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** before → the agent's change → after, on one store. */
async function checkpoint(
  store: ReturnType<typeof createGitCheckpointStore>,
  change: () => void | Promise<void>,
) {
  const before = await store.snapshot(PROJECT, root, { checkpointId: 'c1', side: 'before' });
  await change();
  const after = await store.snapshot(PROJECT, root, { checkpointId: 'c1', side: 'after' });
  const files = await store.diff(PROJECT, before.commit, after.commit);
  const revert = (path: string) =>
    store.revertFile(PROJECT, root, before.commit, after.commit, path);
  return { before, after, files, revert };
}

/** Revert every file the diff offers as revertible, as Revert all does, collecting refusals. */
async function revertAll(
  files: Awaited<ReturnType<typeof checkpoint>>['files'],
  revert: (path: string) => Promise<void>,
): Promise<string[]> {
  const refused: string[] = [];
  for (const file of files) {
    if (file.uncaptured !== undefined) continue;
    await revert(file.path).catch(() => refused.push(file.path));
  }
  return refused;
}

describe.skipIf(!hasGit)('D300 C1: a revert never deletes a file the agent did not add', () => {
  it('the agent rewrites .gitignore to un-ignore .env: Revert all never deletes .env', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('.gitignore', '.env\n');
    write('.env', 'SECRET=person\n');
    const { files, revert } = await checkpoint(store, () => write('.gitignore', 'dist/\n'));

    // the after snapshot uses the before-time rules: .env is still left out, so nothing "added" it
    expect(files.map((file) => file.path)).toEqual(['.gitignore']);
    expect(await revertAll(files, revert)).toEqual([]);
    expect(read('.gitignore')).toBe('.env\n');
    expect(read('.env')).toBe('SECRET=person\n');

    // and asked for by name, it is refused: it was never captured
    const error = await revert('.env').catch((e: unknown) => e);
    expect(isCheckpointConflictError(error)).toBe(true);
    expect((error as Error).message).toBe(
      "ACE could not capture .env (ignored), so it can't be reverted",
    );
    expect(read('.env')).toBe('SECRET=person\n');
  });

  it('a file over 5 MB that the agent shrank is refused, not deleted', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('data.json', Buffer.alloc(CHECKPOINT_FILE_MAX_BYTES + 1, 32));
    const { files, revert } = await checkpoint(store, () => write('data.json', '{}'));

    expect(files).toEqual([
      expect.objectContaining({ path: 'data.json', uncaptured: 'too_large' }),
    ]);
    const error = await revert('data.json').catch((e: unknown) => e);
    expect(isCheckpointConflictError(error)).toBe(true);
    expect((error as Error).message).toBe(
      "ACE could not capture data.json (over 5 MB), so it can't be reverted",
    );
    expect(read('data.json')).toBe('{}');
  });

  it('a file that vanished mid-snapshot is refused, not deleted', async () => {
    write('flaky.txt', 'was there\n');
    write('steady.txt', 'steady\n');
    let vanish = true;
    const store = createGitCheckpointStore(dataDir, {
      // between the listing and the hash, as an editor's save-by-rename does
      onListed: () => {
        if (!vanish) return;
        vanish = false;
        rmSync(join(root, 'flaky.txt'));
      },
    });
    const { files, revert } = await checkpoint(store, () => write('flaky.txt', 'back again\n'));

    expect(files).toEqual([
      expect.objectContaining({ path: 'flaky.txt', change: 'added', uncaptured: 'vanished' }),
    ]);
    expect(isCheckpointConflictError(await revert('flaky.txt').catch((e: unknown) => e))).toBe(
      true,
    );
    expect(read('flaky.txt')).toBe('back again\n');
  });

  it('a newly ignored file the agent rewrote is still captured under the before-time rules', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('notes.md', 'mine\n');
    const { files, revert } = await checkpoint(store, () => {
      write('.gitignore', 'notes.md\n');
      write('notes.md', 'agent\n');
    });
    expect(files.map((file) => `${file.change}:${file.path}`).sort()).toEqual([
      'added:.gitignore',
      'modified:notes.md',
    ]);
    expect(await revertAll(files, revert)).toEqual([]);
    expect(read('notes.md')).toBe('mine\n');
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('deletes only on positive proof: an unknown before commit is an error, never "absent"', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('a.txt', 'a\n');
    const after = await store.snapshot(PROJECT, root, { checkpointId: 'c1', side: 'before' });
    const error = await store
      .revertFile(PROJECT, root, 'f'.repeat(40), after.commit, 'a.txt')
      .catch((e: unknown) => e);
    expect(isCheckpointUnavailableError(error)).toBe(true);
    expect(read('a.txt')).toBe('a\n');
    const missing = await store.fileAt(PROJECT, 'f'.repeat(40), 'a.txt').catch((e: unknown) => e);
    expect(isCheckpointUnavailableError(missing)).toBe(true);
  });
});

describe.skipIf(!hasGit)('D300 I1: a project too large for checkpoints fails honestly', () => {
  it('refuses a listing over the cap instead of snapshotting part of it', async () => {
    const store = createGitCheckpointStore(dataDir, { maxFiles: 3 });
    for (const name of ['a', 'b', 'c', 'd']) write(`${name}.txt`, `${name}\n`);
    const error = await store
      .snapshot(PROJECT, root, { checkpointId: 'c1', side: 'before' })
      .catch((e: unknown) => e);
    expect(isCheckpointUnavailableError(error)).toBe(true);
    expect((error as Error).message).toBe('project too large for checkpoints (over 3 files)');
  });

  it('snapshots exactly at the cap', async () => {
    const store = createGitCheckpointStore(dataDir, { maxFiles: 3 });
    for (const name of ['a', 'b', 'c']) write(`${name}.txt`, `${name}\n`);
    const snap = await store.snapshot(PROJECT, root, { checkpointId: 'c1', side: 'before' });
    expect(snap.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

/** A link to a folder: a junction on Windows (no privilege needed), a symlink elsewhere. */
function linkFolder(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'junction');
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasGit)('D300 merge fix N3: a link covers the paths under its name', () => {
  it('a link swapped for a folder: what is under it is refused, not deleted', async (ctx) => {
    const outside = mkdtempSync(join(tmpdir(), 'ace-cp-outside-'));
    const theirs = 'the person’s, through the link\n';
    try {
      writeFileSync(join(outside, 'x.txt'), theirs);
      if (!linkFolder(outside, join(root, 'shared'))) ctx.skip();
      const store = createGitCheckpointStore(dataDir);
      const { files, revert } = await checkpoint(store, () => {
        // the agent replaces the link with a folder of its own, at the same name
        try {
          unlinkSync(join(root, 'shared'));
        } catch {
          rmdirSync(join(root, 'shared'));
        }
        write('shared/x.txt', 'the agent’s\n');
      });

      expect(files.find((file) => file.path === 'shared/x.txt')).toMatchObject({
        uncaptured: 'unreadable',
      });
      expect(await revertAll(files, revert)).toEqual([]);
      const error = await revert('shared/x.txt').catch((e: unknown) => e);
      expect(isCheckpointConflictError(error)).toBe(true);
      expect(read('shared/x.txt')).toBe('the agent’s\n');
      expect(readFileSync(join(outside, 'x.txt'), 'utf8')).toBe(theirs);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
