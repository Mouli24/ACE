import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitPort } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitPort, GitError } from './git.js';

/*
 * D269 / ACE parity P0 §4: task workspaces are Git worktrees, their changes are diffed against the
 * base commit, and Apply merges the task branch into the project folder. Every test runs against
 * real temporary repositories, with Git's global and system configuration replaced by an empty
 * file so the machine's identity, default branch, hooks path or signing settings cannot leak in.
 */

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

/** The engine's environment without any `GIT_*` variable (a test run from a Git hook has some). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  }
  return env;
}

let root: string;
let hermetic: NodeJS.ProcessEnv;
let git: GitPort;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-git-'));
  const globalConfig = join(root, 'empty.gitconfig');
  writeFileSync(globalConfig, '');
  hermetic = {
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    // Should the temp folder sit inside some repository (a versioned home folder), never reach it.
    GIT_CEILING_DIRECTORIES: root,
  };
  git = createGitPort({ env: hermetic });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 });
});

/** Raw Git for setting a scene up, as a test user, outside the port under test. */
function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test User',
      '-c',
      'user.email=test@example.com',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      cwd,
      env: { ...cleanEnv(), ...hermetic, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

function folder(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function write(dir: string, file: string, content: string | Buffer): void {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), content);
}

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** A repository on `main` with one commit holding the given files. */
function repoWith(files: Record<string, string>, name = 'repo'): string {
  const repo = folder(name);
  sh(repo, 'init', '-q');
  for (const [file, content] of Object.entries(files)) write(repo, file, content);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
  return repo;
}

describe('GitError', () => {
  it('carries the arguments, exit code and stderr', () => {
    const error = new GitError('fatal: nope', { args: ['status'], exitCode: 128, stderr: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'GitError',
      message: 'fatal: nope',
      args: ['status'],
      exitCode: 128,
      stderr: 'x',
    });
    expect(new GitError('bare')).toMatchObject({ args: [], exitCode: null, stderr: '' });
  });
});

describe('FR-GIT-001 inspect without Git', () => {
  it('reports Git unavailable when the binary cannot be run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ace-nogit-'));
    try {
      const missing = createGitPort({ gitBinary: join(dir, 'no-such-git-binary') });
      expect(await missing.inspect(dir)).toEqual({ gitAvailable: false, isRepo: false });
      expect(await missing.inspect(join(dir, 'gone'))).toEqual({
        gitAvailable: false,
        isRepo: false,
      });
      await expect(missing.headSha(dir)).rejects.toThrow(/Git could not be run/);
      await expect(missing.init(dir)).rejects.toThrow(/not installed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!gitAvailable)('FR-GIT-001 inspect', () => {
  it('a plain folder is not a repository', async () => {
    expect(await git.inspect(folder('plain'))).toEqual({ gitAvailable: true, isRepo: false });
  });

  it('a folder that does not exist is not a repository', async () => {
    expect(await git.inspect(join(root, 'missing'))).toEqual({ gitAvailable: true, isRepo: false });
  });

  it('a repository with no commit yet has a branch but no head', async () => {
    const repo = folder('fresh');
    sh(repo, 'init', '-q');
    write(repo, 'staged.txt', 'x\n');
    sh(repo, 'add', 'staged.txt');
    expect(await git.inspect(repo)).toEqual({
      gitAvailable: true,
      isRepo: true,
      branch: 'main',
      clean: false,
      changedFiles: 1,
    });
  });

  it('a subfolder of a repository is not a repository', async () => {
    const repo = repoWith({ 'sub/file.txt': 'x\n' });
    expect(await git.inspect(join(repo, 'sub'))).toEqual({ gitAvailable: true, isRepo: false });
  });

  it('a clean repository: branch, head, clean', async () => {
    const repo = repoWith({ 'a.txt': 'a\n' });
    const status = await git.inspect(repo);
    expect(status).toEqual({
      gitAvailable: true,
      isRepo: true,
      branch: 'main',
      headSha: sh(repo, 'rev-parse', 'HEAD'),
      clean: true,
      changedFiles: 0,
    });
  });

  it('a detached HEAD has a null branch', async () => {
    const repo = repoWith({ 'a.txt': 'a\n' });
    sh(repo, 'checkout', '-q', '--detach');
    const status = await git.inspect(repo);
    expect(status.branch).toBeNull();
    expect(status.headSha).toBe(sh(repo, 'rev-parse', 'HEAD'));
  });

  it('counts tracked changes, and ignores untracked files', async () => {
    const repo = repoWith({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    write(repo, 'a.txt', 'changed\n');
    unlinkSync(join(repo, 'b.txt'));
    write(repo, 'untracked.txt', 'new\n');
    expect(await git.inspect(repo)).toMatchObject({ clean: false, changedFiles: 2 });
  });

  it('reports the origin remote without credentials', async () => {
    const repo = repoWith({ 'a.txt': 'a\n' });
    expect((await git.inspect(repo)).remoteUrl).toBeUndefined();
    sh(repo, 'remote', 'add', 'origin', 'https://someone:s3cret@example.com/team/app.git');
    expect((await git.inspect(repo)).remoteUrl).toBe('https://example.com/team/app.git');
    sh(repo, 'remote', 'set-url', 'origin', 'git@example.com:team/app.git');
    expect((await git.inspect(repo)).remoteUrl).toBe('git@example.com:team/app.git');
  });
});

describe.skipIf(!gitAvailable)('FR-GIT-001 init (D24: an explicit button, never automatic)', () => {
  it('creates a repository on main with an initial commit of what the folder holds', async () => {
    const dir = folder('project');
    write(dir, 'README.md', '# hello\n');
    write(dir, 'src/é ü.ts', 'export {};\n');
    const status = await git.init(dir);
    expect(status).toMatchObject({
      gitAvailable: true,
      isRepo: true,
      branch: 'main',
      clean: true,
      changedFiles: 0,
    });
    expect(status.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(dir, 'log', '-1', '--format=%s|%an|%ae')).toBe('Initial commit|ACE|ace@localhost');
    expect(sh(dir, '-c', 'core.quotepath=off', 'ls-files').split('\n').sort()).toEqual([
      'README.md',
      'src/é ü.ts',
    ]);
  });

  it('makes an empty initial commit in an empty folder', async () => {
    const dir = folder('empty');
    const status = await git.init(dir);
    expect(status.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(dir, 'ls-files')).toBe('');
  });

  it('refuses a folder that is already a repository', async () => {
    const repo = repoWith({ 'a.txt': 'a\n' });
    await expect(git.init(repo)).rejects.toBeInstanceOf(GitError);
    await expect(git.init(repo)).rejects.toThrow(/already a Git repository/);
  });

  it('refuses a folder holding a .git that Git will not open', async () => {
    const dir = folder('broken');
    write(dir, '.git/HEAD', 'not a ref\n');
    expect(await git.inspect(dir)).toEqual({ gitAvailable: true, isRepo: false });
    await expect(git.init(dir)).rejects.toThrow(/already a Git repository/);
    expect(readFileSync(join(dir, '.git', 'HEAD'), 'utf8')).toBe('not a ref\n');
  });

  it('refuses a folder that does not exist', async () => {
    await expect(git.init(join(root, 'nowhere'))).rejects.toThrow(/does not exist/);
  });
});

describe.skipIf(!gitAvailable)('D269 a task worktree: create, commit, changes', () => {
  let repo: string;
  let wt: string;
  let baseSha: string;
  const branch = 'ace/task-1-fix-login';

  beforeEach(async () => {
    repo = repoWith({
      'a.txt': 'one\ntwo\n',
      'b.txt': 'to delete\n',
      'c.txt': TEN_LINES,
      'keep.txt': 'unchanged\n',
    });
    wt = join(root, 'workspaces', 'task-1');
    ({ baseSha } = await git.createWorktree({
      repoPath: repo,
      worktreePath: wt,
      branch,
      baseRef: 'HEAD',
    }));
  });

  it('starts the branch at the base commit, in its own folder', async () => {
    expect(baseSha).toBe(sh(repo, 'rev-parse', 'HEAD'));
    expect(await git.headSha(wt)).toBe(baseSha);
    expect(await git.branchExists(repo, branch)).toBe(true);
    expect(await git.branchExists(repo, 'ace/task-2-other')).toBe(false);
    expect(readFileSync(join(wt, 'keep.txt'), 'utf8')).toBe('unchanged\n');
    expect(await git.inspect(wt)).toMatchObject({ isRepo: true, branch, clean: true });
  });

  it('refuses a base that is not a commit, and a branch that already exists', async () => {
    await expect(
      git.createWorktree({
        repoPath: repo,
        worktreePath: join(root, 'wt-x'),
        branch: 'ace/x',
        baseRef: 'no-such-ref',
      }),
    ).rejects.toThrow(/no-such-ref is not a commit/);
    await expect(
      git.createWorktree({
        repoPath: repo,
        worktreePath: join(root, 'wt-y'),
        branch,
        baseRef: 'HEAD',
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('refuses a name Git would read as an option', async () => {
    await expect(git.branchExists(repo, '--all')).rejects.toThrow(/Invalid branch/);
    await expect(
      git.changes({ cwd: wt, baseSha: '--output=x', includeUncommitted: false }),
    ).rejects.toThrow(/Invalid base/);
  });

  it("commits everything with ACE's identity, and null when there is nothing to commit", async () => {
    write(wt, 'new.txt', 'new\n');
    const commit = await git.commitAll({ cwd: wt, message: 'ACE task #1: Fix login (run 1)' });
    expect(commit).not.toBeNull();
    expect(commit?.sha).toBe(await git.headSha(wt));
    expect(sh(wt, 'log', '-1', '--format=%s|%an <%ae>')).toBe(
      'ACE task #1: Fix login (run 1)|ACE <ace@localhost>',
    );
    expect(await git.commitAll({ cwd: wt, message: 'again' })).toBeNull();
  });

  it("commits with the repository's own identity when it has one", async () => {
    sh(wt, 'config', 'user.name', 'Repo Person');
    write(wt, 'new.txt', 'new\n');
    await git.commitAll({ cwd: wt, message: 'mine' });
    expect(sh(wt, 'log', '-1', '--format=%an <%ae>')).toBe('Repo Person <ace@localhost>');
  });

  it("skips the repository's commit hooks (ACE's own bookkeeping)", async () => {
    const hooks = folder('hooks');
    for (const hook of ['pre-commit', 'commit-msg']) {
      writeFileSync(join(hooks, hook), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    }
    sh(repo, 'config', 'core.hooksPath', hooks.replace(/\\/g, '/'));
    write(wt, 'new.txt', 'new\n');
    // The hooks are live: a plain commit is refused by them.
    sh(wt, 'add', '-A');
    expect(() => sh(wt, 'commit', '-q', '-m', 'with hooks')).toThrow();
    expect(await git.commitAll({ cwd: wt, message: 'hooks skipped' })).not.toBeNull();
  });

  it('lists added, modified, deleted, renamed and binary files with line counts', async () => {
    write(wt, 'a.txt', 'one\nTWO\nthree\n');
    unlinkSync(join(wt, 'b.txt'));
    renameSync(join(wt, 'c.txt'), join(wt, 'c2.txt'));
    write(wt, 'new dir/new file.txt', 'fresh\n');
    write(wt, 'bin.dat', Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
    write(wt, 'naïve 文件.txt', 'unicode\n');
    await git.commitAll({ cwd: wt, message: 'work' });

    const { files, uncommitted } = await git.changes({
      cwd: wt,
      baseSha,
      includeUncommitted: false,
    });
    expect(uncommitted).toBe(false);
    expect(files).toEqual([
      { path: 'a.txt', status: 'modified', additions: 2, deletions: 1, binary: false },
      { path: 'b.txt', status: 'deleted', additions: 0, deletions: 1, binary: false },
      { path: 'bin.dat', status: 'added', additions: null, deletions: null, binary: true },
      {
        path: 'c2.txt',
        oldPath: 'c.txt',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        binary: false,
      },
      { path: 'naïve 文件.txt', status: 'added', additions: 1, deletions: 0, binary: false },
      { path: 'new dir/new file.txt', status: 'added', additions: 1, deletions: 0, binary: false },
    ]);
  });

  it('includes uncommitted and untracked files only when asked, and always says they exist', async () => {
    write(wt, 'a.txt', 'one\ntwo\nthree\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    write(wt, 'untracked.txt', 'u1\nu2\n');
    write(wt, 'keep.txt', 'edited\n');

    const committed = await git.changes({ cwd: wt, baseSha, includeUncommitted: false });
    expect(committed.uncommitted).toBe(true);
    expect(committed.files.map((file) => file.path)).toEqual(['a.txt']);

    const live = await git.changes({ cwd: wt, baseSha, includeUncommitted: true });
    expect(live.uncommitted).toBe(true);
    expect(live.files).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 0, binary: false },
      { path: 'keep.txt', status: 'modified', additions: 1, deletions: 1, binary: false },
      { path: 'untracked.txt', status: 'added', additions: 2, deletions: 0, binary: false },
    ]);

    // Looking did not commit anything, and the next commit takes the untracked file whole.
    expect(await git.headSha(wt)).not.toBe(baseSha);
    await git.commitAll({ cwd: wt, message: 'more' });
    expect(sh(wt, 'show', 'HEAD:untracked.txt')).toBe('u1\nu2');
  });

  it('diffs one file: text, rename, binary, untracked', async () => {
    write(wt, 'a.txt', 'one\nTWO\n');
    renameSync(join(wt, 'c.txt'), join(wt, 'c2.txt'));
    write(wt, 'c2.txt', TEN_LINES + 'line 11\n');
    write(wt, 'bin.dat', Buffer.from([0, 1, 2, 0, 3]));
    await git.commitAll({ cwd: wt, message: 'work' });

    const text = await git.fileDiff({
      cwd: wt,
      baseSha,
      path: 'a.txt',
      includeUncommitted: false,
      maxBytes: 100_000,
    });
    expect(text).toMatchObject({ truncated: false, binary: false });
    expect(text.patch).toContain('-two\n+TWO\n');

    const renamed = await git.fileDiff({
      cwd: wt,
      baseSha,
      path: 'c2.txt',
      includeUncommitted: false,
      maxBytes: 100_000,
    });
    expect(renamed.patch).toContain('rename from c.txt');
    expect(renamed.patch).toContain('rename to c2.txt');
    expect(renamed.patch).toContain('+line 11');

    const binary = await git.fileDiff({
      cwd: wt,
      baseSha,
      path: 'bin.dat',
      includeUncommitted: false,
      maxBytes: 100_000,
    });
    expect(binary).toMatchObject({ binary: true, truncated: false });

    write(wt, 'later.txt', 'not yet committed\n');
    const hidden = await git.fileDiff({
      cwd: wt,
      baseSha,
      path: 'later.txt',
      includeUncommitted: false,
      maxBytes: 100_000,
    });
    expect(hidden).toEqual({ patch: '', truncated: false, binary: false });
    const live = await git.fileDiff({
      cwd: wt,
      baseSha,
      path: 'later.txt',
      includeUncommitted: true,
      maxBytes: 100_000,
    });
    expect(live.patch).toContain('+not yet committed');
  });

  it('reads a pathspec character as part of the file name', async () => {
    // As a glob, `[a].txt` would also match `a.txt`.
    write(wt, '[a].txt', 'bracket\n');
    write(wt, 'a.txt', 'one\ntwo\nchanged too\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    const diff = await git.fileDiff({
      cwd: wt,
      baseSha,
      path: '[a].txt',
      includeUncommitted: false,
      maxBytes: 100_000,
    });
    expect(diff.patch).toContain('+bracket\n');
    expect(diff.patch).not.toContain('changed too');
  });

  it('cuts a long diff at maxBytes, never inside a character', async () => {
    write(wt, 'a.txt', 'é'.repeat(5_000) + '\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    // "é" is two bytes, so one of two neighbouring limits falls inside a character.
    for (const maxBytes of [1_001, 1_002]) {
      const diff = await git.fileDiff({
        cwd: wt,
        baseSha,
        path: 'a.txt',
        includeUncommitted: false,
        maxBytes,
      });
      expect(diff.truncated).toBe(true);
      expect(Buffer.byteLength(diff.patch, 'utf8')).toBeLessThanOrEqual(maxBytes);
      expect(Buffer.byteLength(diff.patch, 'utf8')).toBeGreaterThanOrEqual(maxBytes - 1);
      expect(diff.patch).not.toContain('�');
      expect(diff.patch.startsWith('diff --git a/a.txt b/a.txt')).toBe(true);
    }
  });

  it('diffs a branch from the source repository once its worktree is gone (headRef)', async () => {
    write(wt, 'a.txt', 'one\ntwo\napplied\n');
    write(wt, 'added.txt', 'added\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    await git.removeWorktree({ repoPath: repo, worktreePath: wt });

    // The source repository's HEAD moved on meanwhile; the diff follows the task branch, not HEAD.
    write(repo, 'elsewhere.txt', 'unrelated\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'unrelated');

    const { files } = await git.changes({
      cwd: repo,
      baseSha,
      includeUncommitted: false,
      headRef: branch,
    });
    expect(files.map((file) => `${file.status} ${file.path}`)).toEqual([
      'modified a.txt',
      'added added.txt',
    ]);
    const diff = await git.fileDiff({
      cwd: repo,
      baseSha,
      path: 'a.txt',
      includeUncommitted: false,
      maxBytes: 100_000,
      headRef: branch,
    });
    expect(diff.patch).toContain('+applied');

    // Without headRef the same call reads HEAD — which does not hold the task's work.
    const head = await git.changes({ cwd: repo, baseSha, includeUncommitted: false });
    expect(head.files.map((file) => file.path)).toEqual(['elsewhere.txt']);
  });
});

describe.skipIf(!gitAvailable)('D269 removing a task worktree', () => {
  let repo: string;
  let wt: string;
  const branch = 'ace/task-2-tidy';

  beforeEach(async () => {
    repo = repoWith({ 'a.txt': 'a\n' });
    wt = join(root, 'workspaces', 'task-2');
    await git.createWorktree({ repoPath: repo, worktreePath: wt, branch, baseRef: 'main' });
  });

  it('removes the folder, even with uncommitted work, and keeps the branch unless asked', async () => {
    write(wt, 'a.txt', 'dirty\n');
    write(wt, 'untracked.txt', 'x\n');
    await git.removeWorktree({ repoPath: repo, worktreePath: wt });
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, 'worktree', 'list', '--porcelain')).not.toContain('task-2');
    expect(await git.branchExists(repo, branch)).toBe(true);
  });

  it('deletes the branch when asked, merged or not', async () => {
    write(wt, 'new.txt', 'unmerged work\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    await git.removeWorktree({ repoPath: repo, worktreePath: wt, deleteBranch: branch });
    expect(existsSync(wt)).toBe(false);
    expect(await git.branchExists(repo, branch)).toBe(false);
  });

  it('tolerates a worktree folder that is already gone', async () => {
    rmSync(wt, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 });
    await git.removeWorktree({ repoPath: repo, worktreePath: wt, deleteBranch: branch });
    expect(sh(repo, 'worktree', 'list', '--porcelain')).not.toContain('task-2');
    expect(await git.branchExists(repo, branch)).toBe(false);
    // And a second time, with nothing left at all.
    await git.removeWorktree({ repoPath: repo, worktreePath: wt, deleteBranch: branch });
  });

  it('refuses to remove a folder that is not a worktree', async () => {
    const stray = folder('not-a-worktree');
    write(stray, 'keep.txt', 'mine\n');
    await expect(
      git.removeWorktree({ repoPath: repo, worktreePath: stray }),
    ).rejects.toBeInstanceOf(GitError);
    expect(existsSync(join(stray, 'keep.txt'))).toBe(true);
  });
});

describe.skipIf(!gitAvailable)('D269 Apply merges the task branch into the project folder', () => {
  let repo: string;
  let wt: string;
  const branch = 'ace/task-3-feature';

  beforeEach(async () => {
    repo = repoWith({ 'a.txt': 'one\ntwo\nthree\n' });
    wt = join(root, 'workspaces', 'task-3');
    await git.createWorktree({ repoPath: repo, worktreePath: wt, branch, baseRef: 'HEAD' });
  });

  it('merges with --no-ff: a merge commit, and the files appear in the folder', async () => {
    write(wt, 'feature.txt', 'built by the task\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    const before = sh(repo, 'rev-parse', 'HEAD');

    const result = await git.merge({
      repoPath: repo,
      branch,
      expectedBranch: 'main',
      message: 'ACE task #3: Feature',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sha).toBe(sh(repo, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('built by the task\n');
    const parents = sh(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[1]).toBe(before);
    expect(sh(repo, 'log', '-1', '--format=%s|%an')).toBe('ACE task #3: Feature|ACE');
    expect(await git.inspect(repo)).toMatchObject({ branch: 'main', clean: true });
  });

  it('refuses a folder on another branch, or on a detached HEAD, without touching it', async () => {
    write(wt, 'feature.txt', 'x\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    const head = sh(repo, 'rev-parse', 'HEAD');

    const other = await git.merge({
      repoPath: repo,
      branch,
      expectedBranch: 'release',
      message: 'm',
    });
    expect(other).toMatchObject({ ok: false, reason: 'wrong_branch' });
    if (!other.ok) expect(other.message).toContain('main');

    sh(repo, 'checkout', '-q', '--detach');
    const detached = await git.merge({
      repoPath: repo,
      branch,
      expectedBranch: 'main',
      message: 'm',
    });
    expect(detached).toMatchObject({ ok: false, reason: 'wrong_branch' });
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('refuses a folder with uncommitted tracked changes, but not for untracked files', async () => {
    write(wt, 'feature.txt', 'x\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    const head = sh(repo, 'rev-parse', 'HEAD');

    write(repo, 'a.txt', 'edited by the user\n');
    const dirty = await git.merge({ repoPath: repo, branch, expectedBranch: 'main', message: 'm' });
    expect(dirty).toMatchObject({ ok: false, reason: 'dirty' });
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('edited by the user\n');

    sh(repo, 'checkout', '--', 'a.txt');
    write(repo, 'notes.txt', "the user's own untracked file\n");
    const merged = await git.merge({
      repoPath: repo,
      branch,
      expectedBranch: 'main',
      message: 'm',
    });
    expect(merged.ok).toBe(true);
  });

  it('aborts a conflicting merge and lists the conflicts, leaving the folder as it was', async () => {
    write(wt, 'a.txt', 'one\nTASK\nthree\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    write(repo, 'a.txt', 'one\nUSER\nthree\n');
    sh(repo, 'commit', '-q', '-am', 'user edit');
    const head = sh(repo, 'rev-parse', 'HEAD');

    const result = await git.merge({
      repoPath: repo,
      branch,
      expectedBranch: 'main',
      message: 'm',
    });
    expect(result).toMatchObject({ ok: false, reason: 'conflict', conflicts: ['a.txt'] });
    if (!result.ok) expect(result.message).toContain('a.txt');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(sh(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\nUSER\nthree\n');
  });

  it('reports a merge Git refuses outright as failed', async () => {
    const result = await git.merge({
      repoPath: repo,
      branch: 'ace/no-such-branch',
      expectedBranch: 'main',
      message: 'm',
    });
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

  it('does not abort a merge the user already has in progress', async () => {
    write(wt, 'a.txt', 'one\nTASK\nthree\n');
    await git.commitAll({ cwd: wt, message: 'work' });
    // A merge the user stopped before committing, with nothing to stage: MERGE_HEAD set, tree clean.
    sh(repo, 'merge', '-q', '--no-ff', '-s', 'ours', '--no-commit', branch);
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(sh(repo, 'status', '--porcelain', '-uno')).toBe('');
    const result = await git.merge({
      repoPath: repo,
      branch,
      expectedBranch: 'main',
      message: 'm',
    });
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
  });
});

describe.skipIf(!gitAvailable)("Git errors carry Git's own message", () => {
  it('headSha in a repository with no commit', async () => {
    const repo = folder('unborn');
    sh(repo, 'init', '-q');
    await expect(git.headSha(repo)).rejects.toThrow(/no commit yet/);
  });

  it('a folder that does not exist', async () => {
    await expect(git.headSha(join(root, 'gone'))).rejects.toThrow(/does not exist/);
  });

  it('a command outside any repository', async () => {
    const plain = folder('plain');
    const error = await git.commitAll({ cwd: plain, message: 'm' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as GitError).exitCode).toBe(128);
    expect((error as GitError).message).toMatch(/not a git repository/i);
    expect((error as GitError).args).toContain('add');
  });
});

describe.skipIf(!gitAvailable)('D269 ACE never waits on a signing prompt or a stuck hook', () => {
  it('commits its own bookkeeping unsigned even when the user signs every commit', async () => {
    const repo = repoWith({ 'a.txt': 'a\n' });
    const signing = createGitPort({
      env: {
        ...hermetic,
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'commit.gpgsign',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'gpg.program',
        GIT_CONFIG_VALUE_1: join(root, 'no-such-gpg'),
      },
    });
    const tree = join(root, 'wt');
    await signing.createWorktree({
      repoPath: repo,
      worktreePath: tree,
      branch: 'ace/t',
      baseRef: 'main',
    });
    write(tree, 'b.txt', 'b\n');
    const committed = await signing.commitAll({ cwd: tree, message: 'run 1' });
    expect(committed?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('stops a call whose hook hangs and says so', async () => {
    const repo = repoWith({ 'a.txt': 'a\n' });
    write(repo, '.git/hooks/post-checkout', '#!/bin/sh\nsleep 4\n');
    const impatient = createGitPort({ env: hermetic, timeoutMs: 1_500 });
    await expect(
      impatient.createWorktree({
        repoPath: repo,
        worktreePath: join(root, 'slow'),
        branch: 'ace/slow',
        baseRef: 'main',
      }),
    ).rejects.toThrow(/did not finish within 2 s/);
    // Windows keeps the folder busy until the killed hook's children are gone.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }, 20_000);
});
