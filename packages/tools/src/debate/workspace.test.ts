import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDebateWorkspace } from './workspace.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd },
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr)}`);
};

let project: string;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ace-debate-project-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'cache.ts'), 'export const TTL = 60;');
  writeFileSync(join(project, 'README.md'), '# Demo');
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('D347 DB8 the debate reads snapshot', () => {
  it('reads each path inside the project, once', async () => {
    const snapshot = await createDebateWorkspace().snapshot(project, ['src/cache.ts', 'README.md']);
    expect(snapshot.files).toEqual([
      { path: 'src/cache.ts', content: 'export const TTL = 60;' },
      { path: 'README.md', content: '# Demo' },
    ]);
  });

  it('refuses a path outside the project, naming it', async () => {
    const workspace = createDebateWorkspace();
    await expect(workspace.snapshot(project, ['../outside.txt'])).rejects.toThrow('../outside.txt');
    await expect(workspace.snapshot(project, [resolve(project, 'README.md')])).rejects.toThrow(
      /outside the project folder/,
    );
  });

  it('refuses a path that cannot be read, naming it', async () => {
    await expect(createDebateWorkspace().snapshot(project, ['missing.ts'])).rejects.toThrow(
      'missing.ts',
    );
  });

  it('has no sha outside a git repository', async () => {
    const snapshot = await createDebateWorkspace().snapshot(project, []);
    expect(snapshot).toEqual({ sha: null, dirty: false, files: [] });
  });

  it.runIf(hasGit)('records the commit sha, and whether the work tree is dirty', async () => {
    git(project, 'init', '-q');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'init');
    const clean = await createDebateWorkspace().snapshot(project, ['README.md']);
    expect(clean.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(clean.dirty).toBe(false);

    writeFileSync(join(project, 'README.md'), '# Changed');
    const dirty = await createDebateWorkspace().snapshot(project, ['README.md']);
    expect(dirty.sha).toBe(clean.sha);
    expect(dirty.dirty).toBe(true);
    expect(dirty.files[0]?.content).toBe('# Changed');
  });
});

describe('D359 a scratch folder per turn', () => {
  it('is a fresh, empty folder under the temp dir, gone once disposed', async () => {
    const workspace = createDebateWorkspace();
    const first = await workspace.scratch();
    const second = await workspace.scratch();
    expect(first.dir).not.toBe(second.dir);
    expect(resolve(first.dir).startsWith(resolve(tmpdir()))).toBe(true);
    expect(readdirSync(first.dir)).toEqual([]);
    writeFileSync(join(first.dir, 'notes.md'), 'scratch');
    await first.dispose();
    await second.dispose();
    expect(existsSync(first.dir)).toBe(false);
    expect(existsSync(second.dir)).toBe(false);
  });
});
