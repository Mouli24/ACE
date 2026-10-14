import { type PathLocks } from './session.js';

/**
 * Agentic nodes, Phase 1 (FR-TOOL-008, concurrency between nodes): one write at a time per file
 * across every node of a run. A per-path promise chain: each holder waits for the one before it,
 * and the last one out removes the entry, so a long run does not keep a key per file it touched.
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
  const key = (absolutePath: string): string => (fold ? absolutePath.toLowerCase() : absolutePath);
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
