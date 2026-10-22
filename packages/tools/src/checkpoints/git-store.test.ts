import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isCheckpointConflictError,
  isCheckpointUnavailableError,
  isWorkspaceFsError,
} from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectWriteLocks } from '../agent/locks.js';
import { createGitCheckpointStore, CHECKPOINT_FILE_MAX_BYTES } from './git-store.js';
import { runStoreGit } from './run-store-git.js';

const hasGit = spawnSync('git', ['--version']).status === 0;
const PROJECT = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';

let dataDir: string;
let root: string;

const write = (path: string, content: string | Buffer): void => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
};
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ace-cp-data-'));
  root = mkdtempSync(join(tmpdir(), 'ace-cp-root-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const decode = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');

describe.skipIf(!hasGit)('D300 the private checkpoint store', () => {
  it('snapshots into <dataDir>/checkpoints/<projectId>.git and diffs added, modified and deleted files', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('src/app.ts', 'one\ntwo\nthree\n');
    write('gone.txt', 'bye\n');
    const before = await store.snapshot(PROJECT, root, { checkpointId: 'cp1', side: 'before' });
    expect(existsSync(join(dataDir, 'checkpoints', `${PROJECT}.git`, 'HEAD'))).toBe(true);
    expect(before.skipped).toEqual([]);

    write('src/app.ts', 'one\nTWO\nthree\nfour\n');
    rmSync(join(root, 'gone.txt'));
    write('docs/new.md', 'hello\n');
    write('logo.bin', Buffer.from([0, 1, 2, 0, 3]));
    const after = await store.snapshot(PROJECT, root, { checkpointId: 'cp1', side: 'after' });

    const files = await store.diff(PROJECT, before.commit, after.commit);
    expect(files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'docs/new.md', change: 'added', additions: 1, deletions: 0, binary: false },
      { path: 'gone.txt', change: 'deleted', additions: 0, deletions: 1, binary: false },
      { path: 'logo.bin', change: 'added', additions: 0, deletions: 0, binary: true },
      { path: 'src/app.ts', change: 'modified', additions: 2, deletions: 1, binary: false },
    ]);
    expect(decode(await store.fileAt(PROJECT, before.commit, 'src/app.ts'))).toBe(
      'one\ntwo\nthree\n',
    );
    expect(await store.fileAt(PROJECT, before.commit, 'docs/new.md')).toBeUndefined();
  });

  it('pins each side under refs/ace/<checkpointId>/, and drop unpins both', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('a.txt', 'a\n');
    await store.snapshot(PROJECT, root, { checkpointId: 'cp9', side: 'before' });
    await store.snapshot(PROJECT, root, { checkpointId: 'cp9', side: 'after' });
    const gitDir = join(dataDir, 'checkpoints', `${PROJECT}.git`);
    const refs = (): string =>
      spawnSync('git', ['for-each-ref', '--format=%(refname)'], {
        env: { ...process.env, GIT_DIR: gitDir },
        encoding: 'utf8',
      }).stdout;
    expect(refs()).toContain('refs/ace/cp9/before');
    expect(refs()).toContain('refs/ace/cp9/after');
    await store.drop(PROJECT, 'cp9');
    expect(refs()).not.toContain('refs/ace/cp9');
  });

  it('leaves out .gitignore matches, the default excluded folders and .git/.ace at any depth', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('.gitignore', 'secret.env\nlogs/\n');
    write('secret.env', 'KEY=1\n');
    write('logs/today.log', 'x\n');
    write('node_modules/lib/index.js', 'x\n');
    write('dist/out.js', 'x\n');
    write('.ace/sandbox/run/file.txt', 'x\n');
    write('pkg/.git/config', '[core]\n');
    write('pkg/src/nested.ts', 'nested\n');
    write('keep.ts', 'keep\n');
    const before = await store.snapshot(PROJECT, root, { checkpointId: 'c', side: 'before' });

    for (const path of [
      'secret.env',
      'logs/today.log',
      'node_modules/lib/index.js',
      'dist/out.js',
    ]) {
      expect(await store.fileAt(PROJECT, before.commit, path), path).toBeUndefined();
    }
    expect(await store.fileAt(PROJECT, before.commit, '.ace/sandbox/run/file.txt')).toBeUndefined();
    expect(await store.fileAt(PROJECT, before.commit, 'pkg/.git/config')).toBeUndefined();
    // a nested repository's files are plain files, never a gitlink
    expect(decode(await store.fileAt(PROJECT, before.commit, 'pkg/src/nested.ts'))).toBe(
      'nested\n',
    );
    expect(decode(await store.fileAt(PROJECT, before.commit, 'keep.ts'))).toBe('keep\n');
  });

  it('skips a file over 5 MB and says so', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('big.bin', Buffer.alloc(CHECKPOINT_FILE_MAX_BYTES + 1, 1));
    write('small.txt', 'x\n');
    const snap = await store.snapshot(PROJECT, root, { checkpointId: 'c', side: 'before' });
    expect(snap.skipped).toEqual(['big.bin']);
    expect(await store.fileAt(PROJECT, snap.commit, 'big.bin')).toBeUndefined();
  });

  it('stores bytes as they are: CRLF and a .gitattributes filter change nothing', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('.gitattributes', '* text=auto eol=lf\n*.txt filter=never-run\n');
    write('win.txt', 'a\r\nb\r\n');
    const before = await store.snapshot(PROJECT, root, { checkpointId: 'c', side: 'before' });
    write('win.txt', 'changed\n');
    const after = await store.snapshot(PROJECT, root, { checkpointId: 'c', side: 'after' });

    await store.revertFile(PROJECT, root, before.commit, after.commit, 'win.txt');
    expect(readFileSync(join(root, 'win.txt'))).toEqual(Buffer.from('a\r\nb\r\n'));
  });

  it('never touches the project’s own repository', async () => {
    spawnSync('git', ['init', '-q'], { cwd: root });
    write('a.txt', 'a\n');
    spawnSync('git', ['add', 'a.txt'], { cwd: root });
    const indexBefore = readFileSync(join(root, '.git', 'index'));
    const status = () =>
      spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
    const statusBefore = status();

    const store = createGitCheckpointStore(dataDir);
    write('b.txt', 'b\n');
    const statusWithB = status();
    await store.snapshot(PROJECT, root, { checkpointId: 'c', side: 'before' });

    expect(readFileSync(join(root, '.git', 'index'))).toEqual(indexBefore);
    expect(status()).toBe(statusWithB);
    expect(statusBefore).not.toBe(statusWithB);
  });

  it('ignores inherited GIT_* variables: a stray GIT_DIR cannot redirect it', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('a.txt', 'a\n');
    const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = join(root, 'not-a-repo');
    process.env.GIT_INDEX_FILE = join(root, 'stray-index');
    try {
      const snap = await store.snapshot(PROJECT, root, { checkpointId: 'c', side: 'before' });
      expect(decode(await store.fileAt(PROJECT, snap.commit, 'a.txt'))).toBe('a\n');
    } finally {
      if (saved.dir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved.dir;
      if (saved.index === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved.index;
    }
    expect(existsSync(join(root, 'stray-index'))).toBe(false);
  });

  describe('revertFile', () => {
    async function checkpoint(change: () => void) {
      const store = createGitCheckpointStore(dataDir);
      const before = await store.snapshot(PROJECT, root, { checkpointId: 'c', side: 'before' });
      change();
      const after = await store.snapshot(PROJECT, root, { checkpointId: 'c', side: 'after' });
      const revert = (path: string) =>
        store.revertFile(PROJECT, root, before.commit, after.commit, path);
      return { store, revert };
    }

    it('restores a modified file, deletes an added one and brings back a deleted one with its folders', async () => {
      write('src/a.ts', 'old\n');
      write('deep/dir/gone.ts', 'was here\n');
      const { revert } = await checkpoint(() => {
        write('src/a.ts', 'new\n');
        write('src/added.ts', 'added\n');
        rmSync(join(root, 'deep'), { recursive: true });
      });

      await revert('src/a.ts');
      await revert('src/added.ts');
      await revert('deep/dir/gone.ts');
      expect(read('src/a.ts')).toBe('old\n');
      expect(existsSync(join(root, 'src/added.ts'))).toBe(false);
      expect(read('deep/dir/gone.ts')).toBe('was here\n');
    });

    it('refuses a file that changed after the checkpoint, and leaves it alone', async () => {
      write('a.ts', 'old\n');
      const { revert } = await checkpoint(() => write('a.ts', 'agent\n'));
      write('a.ts', 'person edited after\n');

      const error = await revert('a.ts').catch((e: unknown) => e);
      expect(isCheckpointConflictError(error)).toBe(true);
      expect((error as Error).message).toBe(
        "a.ts changed after the agent's edit; review it before reverting",
      );
      expect(read('a.ts')).toBe('person edited after\n');
    });

    it('refuses an added file the person deleted since, as a conflict', async () => {
      const { revert } = await checkpoint(() => write('new.ts', 'agent\n'));
      rmSync(join(root, 'new.ts'));
      expect(isCheckpointConflictError(await revert('new.ts').catch((e: unknown) => e))).toBe(true);
    });

    it('[audit F-9] takes the file’s write lock: a save holding it lands first, and the revert sees it', async () => {
      write('a.ts', 'old\n');
      const { revert } = await checkpoint(() => write('a.ts', 'agent\n'));
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // a Forge save (or an agent's write) of the same file, holding its lock
      const saving = projectWriteLocks.withLock(join(root, 'a.ts'), async () => {
        await held;
        write('a.ts', 'saved by the person\n');
      });
      const reverting = revert('a.ts').catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(read('a.ts')).toBe('agent\n');
      release();
      await saving;
      expect(isCheckpointConflictError(await reverting)).toBe(true);
      expect(read('a.ts')).toBe('saved by the person\n');
      expect(projectWriteLocks.size()).toBe(0);
    });

    it('never writes outside the project or into .git and .ace', async () => {
      write('a.ts', 'a\n');
      const { revert } = await checkpoint(() => write('a.ts', 'b\n'));
      for (const path of ['../escape.ts', '.git/config', 'pkg/.ace/x']) {
        const error = await revert(path).catch((e: unknown) => e);
        expect(isWorkspaceFsError(error), path).toBe(true);
      }
    });
  });

  it('answers git_missing when git is not installed', async () => {
    const store = createGitCheckpointStore(dataDir, { git: 'ace-no-such-git-binary' });
    write('a.txt', 'a\n');
    const error = await store
      .snapshot(PROJECT, root, { checkpointId: 'c', side: 'before' })
      .catch((e: unknown) => e);
    expect(isCheckpointUnavailableError(error)).toBe(true);
    expect((error as { reason: string }).reason).toBe('git_missing');
  });

  it('keeps no temporary index behind', async () => {
    const store = createGitCheckpointStore(dataDir);
    write('a.txt', 'a\n');
    await store.snapshot(PROJECT, root, { checkpointId: 'c', side: 'before' });
    const gitDir = join(dataDir, 'checkpoints', `${PROJECT}.git`);
    expect(statSync(gitDir).isDirectory()).toBe(true);
    expect(readdirSync(gitDir).filter((name) => name.startsWith('ace-index-'))).toEqual([]);
  });
});

describe.skipIf(!hasGit)('D300 runStoreGit', () => {
  it('runs with an isolated config, writes stdin and answers stdout as bytes', async () => {
    const gitDir = join(dataDir, 'iso.git');
    mkdirSync(gitDir, { recursive: true });
    await runStoreGit(['init', '--bare', '-q'], { gitDir });
    const result = await runStoreGit(['hash-object', '--stdin'], { gitDir, stdin: 'hello\n' });
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8').trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('kills a command that outruns its timeout', async () => {
    const gitDir = join(dataDir, 'slow.git');
    mkdirSync(gitDir, { recursive: true });
    await runStoreGit(['init', '--bare', '-q'], { gitDir });
    // hash-object --stdin waits for stdin that never ends
    const error = await runStoreGit(['hash-object', '--stdin'], {
      gitDir,
      timeoutMs: 200,
      keepStdinOpen: true,
    }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/timed out/);
  });
});
