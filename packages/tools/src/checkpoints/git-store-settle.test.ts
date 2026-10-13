import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isCheckpointUnavailableError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGitCheckpointStore } from './git-store.js';
import type * as RunStoreGit from './run-store-git.js';
import type { StoreGitOptions } from './run-store-git.js';

/*
 * D300 gate fix G-1: when one of the store's parallel git calls fails, the store answers only once
 * every other one has finished too — a git still running holds files in the store, and on Windows
 * that blocks deleting it. Each store command here runs through the real git, and the ones a test
 * names are held back a little after git answers, standing in for a slow side.
 */

const gate = vi.hoisted(() => ({
  /** Store commands that have started and not yet answered. */
  running: 0,
  /** Holds a command back this long after git answers, when `slow` says so. */
  delayMs: 0,
  slow: (_args: readonly string[], _options: StoreGitOptions): boolean => false,
}));

vi.mock('./run-store-git.js', async (importOriginal) => {
  const real = await importOriginal<typeof RunStoreGit>();
  return {
    ...real,
    runStoreGit: async (args: readonly string[], options: StoreGitOptions) => {
      gate.running += 1;
      try {
        const result = await real.runStoreGit(args, options);
        if (gate.slow(args, options)) {
          await new Promise((resolve) => setTimeout(resolve, gate.delayMs));
        }
        return result;
      } finally {
        gate.running -= 1;
      }
    },
  };
});

const hasGit = spawnSync('git', ['--version']).status === 0;
const PROJECT = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const UNKNOWN = 'f'.repeat(40);

let dataDir: string;
let root: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-cp-data-'));
  root = mkdtempSync(join(tmpdir(), 'ace-cp-root-'));
  gate.running = 0;
  gate.delayMs = 0;
  gate.slow = () => false;
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A store with one before snapshot of `a.txt`, its commit and the error a call rejects with. */
async function oneSnapshot() {
  const store = createGitCheckpointStore(dataDir);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'a\n');
  const known = await store.snapshot(PROJECT, root, { checkpointId: 'c1', side: 'before' });
  return { store, known: known.commit };
}

/** Rejects, and says how many store commands were still running at that moment. */
async function runningAtRejection(
  promise: Promise<unknown>,
): Promise<{ error: unknown; running: number }> {
  try {
    await promise;
  } catch (error) {
    return { error, running: gate.running };
  }
  throw new Error('expected a rejection');
}

describe.skipIf(!hasGit)('D300 G-1: a failed store call waits for its other git commands', () => {
  it('revertFile rejects for an unknown commit only after the other side has finished', async () => {
    const { store, known } = await oneSnapshot();
    // every command that is not about the unknown commit is slow
    gate.delayMs = 300;
    gate.slow = (_args, options) =>
      typeof options.stdin === 'string' && !options.stdin.includes(UNKNOWN);

    const outcome = await runningAtRejection(
      store.revertFile(PROJECT, root, UNKNOWN, known, 'a.txt'),
    );
    expect(isCheckpointUnavailableError(outcome.error)).toBe(true);
    expect(outcome.running).toBe(0);
  });

  it('revertFile rethrows the first side’s error when both sides fail, even when it fails last', async () => {
    const { store } = await oneSnapshot();
    // the before side fails once git has looked; the after side fails at once, without git
    const beforeFirst = await store
      .revertFile(PROJECT, root, UNKNOWN, 'not-a-commit', 'a.txt')
      .catch((e: unknown) => e);
    expect(isCheckpointUnavailableError(beforeFirst)).toBe(true);
    expect((beforeFirst as Error).message).toBe('That checkpoint commit is not in the store.');

    const afterFirst = await store
      .revertFile(PROJECT, root, 'not-a-commit', UNKNOWN, 'a.txt')
      .catch((e: unknown) => e);
    expect((afterFirst as Error).message).toBe('That is not a checkpoint commit.');
  });

  it('diff rejects for an unknown commit only after its other git commands have finished', async () => {
    const { store, known } = await oneSnapshot();
    gate.delayMs = 300;
    gate.slow = (args) => args.includes('cat-file');

    const outcome = await runningAtRejection(store.diff(PROJECT, UNKNOWN, known));
    expect(isCheckpointUnavailableError(outcome.error)).toBe(true);
    expect(outcome.running).toBe(0);
  });
});
