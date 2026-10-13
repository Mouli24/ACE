import type { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STORE_GIT_MAX_OUTPUT_BYTES, runStoreGit } from './run-store-git.js';

/*
 * D300 gate fix G-1: a killed store command is answered only once git has exited, because until
 * then it holds files in the store (on Windows an open file blocks deleting its folder). The child
 * is a stand-in, so the test decides when it exits.
 */

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter & { setEncoding: () => EventEmitter };
  stdin: EventEmitter & { write: () => boolean; end: () => void; destroy: () => void };
  signals: string[];
  kill: (signal: string) => boolean;
}

const children = vi.hoisted(() => [] as FakeChild[]);

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawn: (): FakeChild => {
      const stderr = Object.assign(new EventEmitter(), {
        setEncoding: () => stderr,
      });
      const child: FakeChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr,
        stdin: Object.assign(new EventEmitter(), {
          write: () => true,
          end: () => undefined,
          destroy: () => undefined,
        }),
        signals: [] as string[],
        kill: (signal: string) => {
          child.signals.push(signal);
          return true;
        },
      });
      children.push(child);
      return child;
    },
  };
});

/** The promise's outcome so far, without awaiting it. */
function track(promise: Promise<unknown>): { settled: boolean; error: unknown } {
  const state = { settled: false, error: undefined as unknown };
  promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

const child = (): FakeChild => {
  const only = children[0];
  if (only === undefined) throw new Error('nothing was spawned');
  return only;
};

beforeEach(() => {
  children.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('D300 G-1 runStoreGit answers a killed command only once it has exited', () => {
  it('a timeout kills the command, and rejects only after it closes', async () => {
    const outcome = track(
      runStoreGit(['hash-object', '--stdin'], { gitDir: 'store.git', timeoutMs: 100 }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(child().signals).toEqual(['SIGKILL']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome.settled).toBe(false);

    child().emit('close', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome.settled).toBe(true);
    expect((outcome.error as Error).message).toMatch(/timed out/);
  });

  it('too much output kills the command, and rejects with that error once it closes, even with 0', async () => {
    const outcome = track(runStoreGit(['cat-file', '--batch'], { gitDir: 'store.git' }));
    child().stdout.emit('data', Buffer.alloc(STORE_GIT_MAX_OUTPUT_BYTES + 1));
    expect(child().signals).toEqual(['SIGKILL']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome.settled).toBe(false);

    child().emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect((outcome.error as Error).message).toMatch(/answered too much/);
  });

  it('rejects anyway 2 s after the kill when the command never closes', async () => {
    const outcome = track(
      runStoreGit(['hash-object', '--stdin'], { gitDir: 'store.git', timeoutMs: 100 }),
    );
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((outcome.error as Error).message).toMatch(/timed out/);
  });

  it('still answers a command that exits on its own as before', async () => {
    const result = runStoreGit(['hash-object', '--stdin'], { gitDir: 'store.git', stdin: 'x' });
    child().stdout.emit('data', Buffer.from('abc\n'));
    child().emit('close', 0);
    await expect(result).resolves.toEqual({ code: 0, stdout: Buffer.from('abc\n'), stderr: '' });
    expect(child().signals).toEqual([]);
  });
});
