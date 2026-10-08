import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import { GIT_DIFF_DEFINITION, GIT_STATUS_DEFINITION, createGitDiffTool, createGitStatusTool } from './git.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
let project: string;
let cleanups: (() => void)[] = [];

const git = (...args: string[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8' });

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ace git '));
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  rmSync(project, { recursive: true, force: true });
});

const ctx = () => {
  const context = makeContext({ projectDir: project });
  cleanups.push(context.cleanup);
  return context;
};

function repo(): void {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ace@example.invalid');
  git('config', 'user.name', 'ACE test');
  writeFileSync(join(project, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
}

describe.skipIf(!hasGit)('FR-TOOL-008 git tools', () => {
  it('git_status reports the branch and changed files', async () => {
    repo();
    writeFileSync(join(project, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(project, 'b.txt'), 'new\n');
    expect(await createGitStatusTool().implementation({}, ctx())).toEqual({
      branch: 'main',
      entries: [' M a.txt', '?? b.txt'],
      clean: false,
    });
  });

  it('git_diff shows unstaged and staged changes, and one path', async () => {
    repo();
    writeFileSync(join(project, 'a.txt'), 'one\ntwo\n');
    const unstaged = (await createGitDiffTool().implementation({}, ctx())) as { diff: string };
    expect(unstaged.diff).toContain('+two');
    git('add', 'a.txt');
    expect(((await createGitDiffTool().implementation({}, ctx())) as { diff: string }).diff).toBe('');
    expect(((await createGitDiffTool().implementation({ staged: true, path: 'a.txt' }, ctx())) as { diff: string }).diff).toContain('+two');
  });

  it('refuses a path outside the project, and says when there is no repository', async () => {
    repo();
    await expect(createGitDiffTool().implementation({ path: '../x' }, ctx())).rejects.toThrow(/inside the project folder/);
    rmSync(join(project, '.git'), { recursive: true, force: true });
    await expect(createGitStatusTool().implementation({}, ctx())).rejects.toThrow(/not a git repository/);
  });

  it('neither tool is destructive', () => {
    expect(GIT_STATUS_DEFINITION.permissions.destructive).toBe(false);
    expect(GIT_DIFF_DEFINITION.permissions.destructive).toBe(false);
  });
});
