import { resolve } from 'node:path';

import { type PathLocks } from './session.js';

/**
 * Agentic nodes, Phase 1 (FR-TOOL-008, concurrency between nodes): one write at a time per file.
 * A per-path promise chain: each holder waits for the one before it, and the last one out removes
 * the entry, so a long run does not keep a key per file it touched.
 *
 * PG-5.2 (D361): the engine shares one set, {@link projectWriteLocks}, between every writer of a
 * project folder — each run's nodes, a chat turn's file tools, and the person's saves, creates,
 * moves and removes through Forge — so an agent's "seen current" check and its write can never
 * interleave with a save of the same file.
 */

export interface PathLocksOptions {
  /** Windows paths are case-insensitive, so they are keyed folded. Defaults to this process's. */
  readonly platform?: NodeJS.Platform;
}

export interface CountedPathLocks extends PathLocks {
  /** How many paths are held or queued on right now (tests: nothing leaks after release). */
  size(): number;
}

export function createPathLocks(options: PathLocksOptions = {}): CountedPathLocks {
  const fold = (options.platform ?? process.platform) === 'win32';
  const key = (absolutePath: string): string => {
    const normal = resolve(absolutePath);
    return fold ? normal.toLowerCase() : normal;
  };
  /** The tail of each path's queue: settles when the last holder queued so far releases. */
  const tails = new Map<string, Promise<void>>();

  return {
    async withLock<T>(absolutePath: string, fn: () => Promise<T>): Promise<T> {
      const id = key(absolutePath);
      const before = tails.get(id) ?? Promise.resolve();
      let release = (): void => undefined;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = before.then(() => mine);
      tails.set(id, tail);
      await before;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(id) === tail) tails.delete(id);
      }
    },
    size: () => tails.size,
  };
}

/**
 * PG-5.2: the engine-wide write locks. Keys are absolute paths, so one set serves every project:
 * a run's agent session, a chat turn's file tools (no session) and Forge's file routes all take
 * the lock of the file they write here.
 */
export const projectWriteLocks: CountedPathLocks = createPathLocks();

/**
 * Holds the write locks of several paths at once — a move's source and target — always taken in
 * one order, so two writers that need the same pair never wait on each other.
 */
export function withPathLocks<T>(
  locks: PathLocks,
  absolutePaths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(absolutePaths.map((path) => resolve(path)))].sort();
  const take = (index: number): Promise<T> =>
    index >= ordered.length
      ? fn()
      : locks.withLock(ordered[index] as string, () => take(index + 1));
  return take(0);
}
