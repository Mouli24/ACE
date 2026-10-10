import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePorcelainZ, readRepoStatus } from './repo-status.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('D299 reading git status for the Explorer', () => {
  it('reads the branch and modified, added, deleted, renamed and untracked entries', () => {
    const stdout = [
      '## main...origin/main [ahead 1]',
      ' M src/a.ts',
      'A  src/new.ts',
      ' D gone.ts',
      'R  to.ts',
      'from.ts',
      'MM both.ts',
      'UU conflict.ts',
      '?? scratch/',
      '?? notes.md',
      '',
    ].join('\0');

    expect(parsePorcelainZ(stdout, '', false)).toEqual({
      repo: true,
      branch: 'main',
      truncated: false,
      files: [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/new.ts', status: 'added' },
        { path: 'gone.ts', status: 'deleted' },
        { path: 'to.ts', status: 'renamed' },
        { path: 'both.ts', status: 'modified' },
        { path: 'conflict.ts', status: 'modified' },
        { path: 'scratch', status: 'untracked' },
        { path: 'notes.md', status: 'untracked' },
      ],
    });
  });

  it('keeps only the entries under the project when it is a subfolder of the repository', () => {
    const stdout = ['## main', ' M apps/web/src/a.ts', ' M other/b.ts', ''].join('\0');
    expect(parsePorcelainZ(stdout, 'apps/web/', true)).toEqual({
      repo: true,
      branch: 'main',
      truncated: true,
      files: [{ path: 'src/a.ts', status: 'modified' }],
    });
  });

  it('reads a branch with no commits yet, and a detached HEAD', () => {
    expect(parsePorcelainZ('## No commits yet on main\0', '', false)).toMatchObject({
      branch: 'main',
    });
    expect(parsePorcelainZ('## HEAD (no branch)\0', '', false)).toMatchObject({ branch: null });
  });
});

describe.skipIf(!hasGit)('D299 status of a real folder', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ace-status-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

  const git = (...args: string[]) =>
    spawnSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root },
    );

  it('answers repo: false for a folder that is not a repository', async () => {
    expect(await readRepoStatus(root)).toEqual({ repo: false });
  });

  it('reports a modified file and an untracked folder', async () => {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.txt'), '1');
    git('add', '.');
    git('commit', '-qm', 'one');
    writeFileSync(join(root, 'a.txt'), '2');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'new.md'), 'x');

    const status = await readRepoStatus(root);

    expect(status).toMatchObject({ repo: true, branch: 'main', truncated: false });
    expect(status.repo ? status.files : []).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'docs', status: 'untracked' },
    ]);
  });
});
