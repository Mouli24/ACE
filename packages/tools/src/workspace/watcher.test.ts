import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FileChangeBatch } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { watchProject } from './watcher.js';

let root: string;
let stop: () => void = () => undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-watch-'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, 'sub'));
});
afterEach(() => {
  stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

function collect(options: { maxChanges?: number } = {}) {
  const batches: FileChangeBatch[] = [];
  const errors: Error[] = [];
  stop = watchProject(
    root,
    (batch) => batches.push(batch),
    (error) => errors.push(error),
    {
      debounceMs: 50,
      ...options,
    },
  );
  return { batches, errors, changes: () => batches.flatMap((batch) => batch.changes) };
}

describe('D299 the project watcher', () => {
  it('reports a created, a changed and a deleted file', async () => {
    const seen = collect();
    await settle();

    writeFileSync(join(root, 'a.txt'), '1');
    await vi.waitFor(
      () => expect(seen.changes()).toContainEqual({ path: 'a.txt', kind: 'created' }),
      {
        timeout: 4000,
      },
    );
    await settle();
    writeFileSync(join(root, 'a.txt'), '22');
    await vi.waitFor(
      () =>
        expect(seen.changes().some((c) => c.path === 'a.txt' && c.kind === 'changed')).toBe(true),
      { timeout: 4000 },
    );
    rmSync(join(root, 'a.txt'));
    await vi.waitFor(
      () => expect(seen.changes()).toContainEqual({ path: 'a.txt', kind: 'deleted' }),
      {
        timeout: 4000,
      },
    );
    expect(seen.errors).toEqual([]);
  });

  it('uses forward slashes for nested paths', async () => {
    const seen = collect();
    await settle();
    writeFileSync(join(root, 'sub', 'b.txt'), 'x');
    await vi.waitFor(() => expect(seen.changes().map((c) => c.path)).toContain('sub/b.txt'), {
      timeout: 4000,
    });
  });

  it('says nothing about .git, ignored folders or its own temporary save files', async () => {
    const seen = collect();
    await settle();
    writeFileSync(join(root, '.git', 'index'), 'x');
    writeFileSync(join(root, 'node_modules', 'y.js'), 'x');
    writeFileSync(join(root, '.a.txt.0123456789ab.ace-save'), 'x');
    writeFileSync(join(root, 'marker.txt'), 'x');

    await vi.waitFor(() => expect(seen.changes().map((c) => c.path)).toContain('marker.txt'), {
      timeout: 4000,
    });
    const leaked = seen
      .changes()
      .map((c) => c.path)
      .filter(
        (p) => p.startsWith('.git') || p.startsWith('node_modules/') || p.endsWith('.ace-save'),
      );
    expect(leaked).toEqual([]);
  });

  it('never reports an ignored folder itself, only real files', async () => {
    writeFileSync(join(root, '.gitignore'), 'out/\n');
    mkdirSync(join(root, 'out'));
    const seen = collect();
    await settle();
    mkdirSync(join(root, 'node_modules', 'pkg'));
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    writeFileSync(join(root, 'out', 'bundle.js'), 'x');
    writeFileSync(join(root, 'marker.txt'), 'x');

    await vi.waitFor(() => expect(seen.changes().map((c) => c.path)).toContain('marker.txt'), {
      timeout: 4000,
    });
    await settle();
    const leaked = seen
      .changes()
      .map((c) => c.path)
      .filter((p) => ['node_modules', 'out'].some((d) => p === d || p.startsWith(`${d}/`)));
    expect(leaked).toEqual([]);
  });

  it("does not report a folder's own change, only the file inside it", async () => {
    const seen = collect();
    await settle();
    writeFileSync(join(root, 'sub', 'c.txt'), 'x');
    await vi.waitFor(() => expect(seen.changes().map((c) => c.path)).toContain('sub/c.txt'), {
      timeout: 4000,
    });
    await settle();
    expect(seen.changes().filter((c) => c.path === 'sub' && c.kind === 'changed')).toEqual([]);
  });

  it('a burst over the limit arrives as one resync', async () => {
    const seen = collect({ maxChanges: 3 });
    await settle();
    for (let i = 0; i < 8; i += 1) writeFileSync(join(root, `f${i}.txt`), 'x');
    await vi.waitFor(() => expect(seen.batches).toContainEqual({ changes: [], resync: true }), {
      timeout: 4000,
    });
  });

  it('stops reporting once stopped', async () => {
    const seen = collect();
    await settle();
    stop();
    writeFileSync(join(root, 'late.txt'), 'x');
    await settle(400);
    expect(seen.batches).toEqual([]);
  });
});
