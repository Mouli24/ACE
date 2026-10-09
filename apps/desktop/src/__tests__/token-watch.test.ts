import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readTokenFile, watchSessionToken, type WatchDir } from '../token-watch.js';

const FILE = join('data', 'session-token');

/** A directory watcher the test fires by hand. */
function fakeWatch(): {
  watchDir: WatchDir;
  fire: (filename: string | null) => void;
  fail: () => void;
  started: () => number;
} {
  let onEvent: ((filename: string | null) => void) | undefined;
  let onError: (() => void) | undefined;
  let started = 0;
  return {
    watchDir: (_dir, event, error) => {
      started += 1;
      onEvent = event;
      onError = error;
      return { close: () => undefined };
    },
    fire: (filename) => onEvent?.(filename),
    fail: () => onError?.(),
    started: () => started,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FR-DSK-002 the dev window follows the engine’s session token (D295)', () => {
  it('debounces a burst of events into one read, and reports only a changed token', () => {
    vi.useFakeTimers();
    const watch = fakeWatch();
    let onDisk = 'one';
    const onChange = vi.fn();
    const watcher = watchSessionToken({
      file: FILE,
      current: 'one',
      onChange,
      debounceMs: 300,
      pollMs: 60_000,
      readToken: () => onDisk,
      watchDir: watch.watchDir,
    });

    // fs.watch on Windows: several events for one write.
    onDisk = 'two';
    watch.fire('session-token');
    vi.advanceTimersByTime(100);
    watch.fire('session-token');
    vi.advanceTimersByTime(100);
    watch.fire(null);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('two');

    // The same token again (a touch, a second watcher event late) is not news.
    watch.fire('session-token');
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it('ignores other files in the data dir, and a missing or empty token file', () => {
    vi.useFakeTimers();
    const watch = fakeWatch();
    let onDisk: string | undefined;
    const onChange = vi.fn();
    const watcher = watchSessionToken({
      file: FILE,
      onChange,
      pollMs: 60_000,
      readToken: () => onDisk,
      watchDir: watch.watchDir,
    });

    onDisk = 'x';
    watch.fire('ace.sqlite-wal');
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();

    onDisk = undefined;
    watch.fire('session-token');
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
    watcher.close();
  });

  it('starts watching once the data dir exists, and re-watches after an error', () => {
    vi.useFakeTimers();
    let dirExists = false;
    const watch = fakeWatch();
    const disk: { token?: string } = {};
    const onChange = vi.fn();
    const watcher = watchSessionToken({
      file: FILE,
      onChange,
      pollMs: 1_000,
      readToken: () => disk.token,
      watchDir: (dir, event, error) => {
        if (!dirExists) throw new Error('ENOENT');
        return watch.watchDir(dir, event, error);
      },
    });
    expect(watch.started()).toBe(0);

    dirExists = true;
    disk.token = 'first';
    vi.advanceTimersByTime(1_000 + 300);
    expect(watch.started()).toBe(1);
    // The poll itself also caught the first token.
    expect(onChange).toHaveBeenCalledWith('first');

    watch.fail();
    vi.advanceTimersByTime(1_000);
    expect(watch.started()).toBe(2);
    watcher.close();
  });

  it('after close, nothing more is reported', () => {
    vi.useFakeTimers();
    const watch = fakeWatch();
    let onDisk = 'a';
    const onChange = vi.fn();
    const watcher = watchSessionToken({
      file: FILE,
      current: 'a',
      onChange,
      readToken: () => onDisk,
      watchDir: watch.watchDir,
    });
    onDisk = 'b';
    watch.fire('session-token');
    watcher.close();
    vi.advanceTimersByTime(10_000);
    watch.fire('session-token');
    vi.advanceTimersByTime(10_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('FR-DSK-002 against the real file system', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('readTokenFile trims, and answers undefined for a missing or blank file', () => {
    dir = mkdtempSync(join(tmpdir(), 'ace-desktop-token-'));
    const file = join(dir, 'session-token');
    expect(readTokenFile(file)).toBeUndefined();
    writeFileSync(file, '  \n');
    expect(readTokenFile(file)).toBeUndefined();
    writeFileSync(file, 'abc123\n');
    expect(readTokenFile(file)).toBe('abc123');
  });

  it('an engine restart that rewrites the file is reported once', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ace-desktop-token-'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'session-token');
    writeFileSync(file, 'before', { mode: 0o600 });

    const seen: string[] = [];
    const watcher = watchSessionToken({
      file,
      current: 'before',
      debounceMs: 100,
      pollMs: 60_000,
      onChange: (token) => seen.push(token),
    });
    try {
      writeFileSync(file, 'after', { mode: 0o600 });
      await vi.waitFor(() => expect(seen).toEqual(['after']), { timeout: 5_000, interval: 50 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(seen).toEqual(['after']);
    } finally {
      watcher.close();
    }
  });
});
