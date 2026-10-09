import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('never runs a fsmonitor hook or an external diff the repository config names (review C1)', async () => {
    repo();
    const outside = mkdtempSync(join(tmpdir(), 'ace-git-hook-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    const marker = join(outside, 'ran.txt').split('\\').join('/');
    const hook = join(outside, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(hook, 0o755);
    const hookPath = hook.split('\\').join('/');
    git('config', 'core.fsmonitor', hookPath);
    git('config', 'diff.external', hookPath);
    writeFileSync(join(project, 'a.txt'), 'one\ntwo\n');

    await createGitStatusTool().implementation({}, ctx());
    await createGitDiffTool().implementation({}, ctx());
    expect(existsSync(marker)).toBe(false);
  });

  it('stays inside a project folder that is a sub-folder of a larger repository (review I7)', async () => {
    repo();
    mkdirSync(join(project, 'app'));
    writeFileSync(join(project, 'app', 'x.txt'), '1\n');
    git('add', '-A');
    git('commit', '-qm', 'app');
    writeFileSync(join(project, 'a.txt'), 'one\noutside\n');
    writeFileSync(join(project, 'app', 'x.txt'), '1\ninside\n');
    const context = makeContext({ projectDir: join(project, 'app') });
    cleanups.push(context.cleanup);

    const status = (await createGitStatusTool().implementation({}, context)) as { entries: string[] };
    expect(status.entries).toHaveLength(1);
    expect(status.entries[0]).toContain('x.txt');
    const diff = (await createGitDiffTool().implementation({}, context)) as { diff: string };
    expect(diff.diff).toContain('+inside');
    expect(diff.diff).not.toContain('outside');
    // Pathspec magic is a literal name, not a way back to the repository's top.
    const magic = (await createGitDiffTool().implementation({ path: ':(top)' }, context)) as { diff: string };
    expect(magic.diff).toBe('');
  });

  it('neither tool is destructive', () => {
    expect(GIT_STATUS_DEFINITION.permissions.destructive).toBe(false);
    expect(GIT_DIFF_DEFINITION.permissions.destructive).toBe(false);
  });
});
