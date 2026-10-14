import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { changedPaths, snapshotWorkspace } from './changes.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-changes-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) throw new Error(result.stderr);
};
const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

describe('FR-TOOL-008 command change detection (agentic nodes)', () => {
  it('git work tree: new, modified-again, deleted and committed-only files', async () => {
    write(join(root, 'clean.txt'), 'clean');
    write(join(root, 'dirty.txt'), 'v1');
    write(join(root, 'gone.txt'), 'bye');
    write(join(root, 'commit-me.txt'), 'c1');
    write(join(root, 'still-dirty.txt'), 's1');
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'init');
    write(join(root, 'dirty.txt'), 'v2');
    write(join(root, 'commit-me.txt'), 'c2');
    write(join(root, 'still-dirty.txt'), 's2');

    const before = await snapshotWorkspace(root);
    expect(before.kind).toBe('git');

    write(join(root, 'dirty.txt'), 'v3 longer');
    write(join(root, 'src', 'deep', 'new file.ts'), 'export {}');
    write(join(root, 'clean.txt'), 'changed now');
    unlinkSync(join(root, 'gone.txt'));
    git(root, 'commit', '-q', '-m', 'only commits, no content change', '--', 'commit-me.txt');

    const after = await snapshotWorkspace(root, { previous: before });
    expect(changedPaths(before, after)).toEqual([
      'clean.txt',
      'dirty.txt',
      'gone.txt',
      'src/deep/new file.ts',
    ]);
  });

  it('a project folder inside a larger repository: paths relative to the project', async () => {
    git(root, 'init', '-q');
    write(join(root, 'outside.txt'), 'x');
    const project = join(root, 'apps', 'demo');
    mkdirSync(project, { recursive: true });
    const before = await snapshotWorkspace(project);
    write(join(project, 'a.txt'), 'a');
    write(join(root, 'outside-2.txt'), 'x');
    const after = await snapshotWorkspace(project, { previous: before });
    expect(after.kind).toBe('git');
    expect(changedPaths(before, after)).toEqual(['a.txt']);
  });

  it('not a repository: an mtime walk that skips .git, node_modules and .ace', async () => {
    write(join(root, 'keep.txt'), 'k');
    write(join(root, 'edit.txt'), 'e');
    const before = await snapshotWorkspace(root);
    expect(before.kind).toBe('walk');
    write(join(root, 'edit.txt'), 'edited');
    write(join(root, 'sub', 'new.txt'), 'n');
    write(join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    write(join(root, '.ace', 'state.json'), '{}');
    const after = await snapshotWorkspace(root, { previous: before });
    expect(changedPaths(before, after)).toEqual(['edit.txt', 'sub/new.txt']);
  });

  it('the walk is bounded', async () => {
    for (let i = 0; i < 20; i += 1) write(join(root, `f${i}.txt`), 'x');
    const snapshot = await snapshotWorkspace(root, { maxEntries: 5 });
    expect(snapshot.entries.size).toBe(5);
    expect(snapshot.truncated).toBe(true);
  });

  it('nothing changed → nothing reported', async () => {
    write(join(root, 'a.txt'), 'a');
    const before = await snapshotWorkspace(root);
    const after = await snapshotWorkspace(root, { previous: before });
    expect(changedPaths(before, after)).toEqual([]);
  });
});
