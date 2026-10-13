import { randomBytes } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CheckpointFileChange } from '@ace/contracts';
import {
  CheckpointConflictError,
  CheckpointUnavailableError,
  type CheckpointFileDiffEntry,
  type CheckpointStore,
  type SnapshotRef,
} from '@ace/engine';

import { atomicWrite, listAllFiles } from '../workspace/fs-files.js';
import { toAbsolute } from '../workspace/resolve.js';
import {
  STORE_GLOBAL_CONFIG,
  runStoreGit,
  storeGitFailed,
  type StoreGitOptions,
  type StoreGitResult,
} from './run-store-git.js';

/*
 * The private checkpoint store (D300, design §5.1): one git repository per project at
 * `<dataDir>/checkpoints/<projectId>.git`, used against the project folder but never through the
 * project's own `.git`, index, branches or stash. Snapshots hash the folder's bytes as they are —
 * no filters, no line-ending conversion — into a fresh temporary index, so the person's repository
 * and any `.gitattributes` in the project change nothing and run nothing.
 */

/** A file over this is left out of a snapshot and reported as skipped. */
export const CHECKPOINT_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** The most files one snapshot lists; the rest of a giant folder is not covered. */
const SNAPSHOT_FILE_LIMIT = 200_000;
/** Files stat'ed at once while listing. */
const STAT_BATCH = 64;
/** A file that vanishes, or a name git refuses, is dropped and the step retried this often. */
const MAX_RETRIES = 50;

const AUTHOR = { name: 'ACE', email: 'ace@localhost' };
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;

export interface GitCheckpointStoreOptions {
  /** The git binary; tests name one that does not exist. */
  git?: string;
}

interface Candidate {
  path: string;
  mode: '100644' | '100755';
}

const unavailable = (message: string): CheckpointUnavailableError =>
  new CheckpointUnavailableError('failed', message);

function assertSafeName(what: string, value: string): void {
  if (!SAFE_NAME.test(value)) throw unavailable(`That ${what} cannot name a checkpoint.`);
}

function assertCommit(value: string): void {
  if (!COMMIT_ID.test(value)) throw unavailable('That is not a checkpoint commit.');
}

/** `--stdin-paths` reads a line starting with `"` as a C-quoted name: quote such a name. */
const pathLine = (path: string): string =>
  path.startsWith('"') ? `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : path;

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a === undefined || b === undefined ? a === b : Buffer.from(a).equals(Buffer.from(b));

const changeOf = (status: string): CheckpointFileChange =>
  status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified';

export function createGitCheckpointStore(
  dataDir: string,
  options: GitCheckpointStoreOptions = {},
): CheckpointStore {
  const ready = new Map<string, Promise<string>>();
  const storeDirOf = (projectId: string): string =>
    join(resolve(dataDir), 'checkpoints', `${projectId}.git`);

  const git = (
    args: readonly string[],
    gitDir: string,
    extra: Omit<StoreGitOptions, 'gitDir'> = {},
  ): Promise<StoreGitResult> =>
    runStoreGit(args, {
      gitDir,
      ...extra,
      ...(options.git === undefined ? {} : { git: options.git }),
    });

  /** Like `git`, but a non-zero exit is an error. */
  const gitOk = async (
    args: readonly string[],
    gitDir: string,
    extra: Omit<StoreGitOptions, 'gitDir'> = {},
  ): Promise<Buffer> => {
    const result = await git(args, gitDir, extra);
    if (result.code !== 0) throw storeGitFailed(args, result);
    return result.stdout;
  };

  async function create(projectId: string): Promise<string> {
    const gitDir = storeDirOf(projectId);
    await fs.mkdir(gitDir, { recursive: true });
    // the global config git is pointed at: empty, and created before git first runs
    await fs.writeFile(join(gitDir, STORE_GLOBAL_CONFIG), '', { flag: 'a' });
    const head = await fs.stat(join(gitDir, 'HEAD')).catch(() => undefined);
    if (head === undefined) {
      await gitOk(['init', '--bare', '-q'], gitDir);
      await gitOk(['config', 'gc.auto', '0'], gitDir);
      await gitOk(['config', 'core.logAllRefUpdates', 'false'], gitDir);
    }
    return gitDir;
  }

  /** The project's store, created on first use; concurrent first uses share one creation. */
  function storeOf(projectId: string): Promise<string> {
    assertSafeName('project', projectId);
    let pending = ready.get(projectId);
    if (pending === undefined) {
      pending = create(projectId);
      ready.set(projectId, pending);
      pending.catch(() => ready.delete(projectId));
    }
    return pending;
  }

  /** Every file the snapshot covers, and the ones left out for size. */
  async function candidates(base: string): Promise<{ files: Candidate[]; skipped: string[] }> {
    const listing = await listAllFiles(base, SNAPSHOT_FILE_LIMIT);
    // the data dir inside the project folder must never snapshot its own store
    const data = relative(base, resolve(dataDir));
    const dataInside = data !== '' && !data.startsWith('..') && !isAbsolute(data);
    const dataPrefix = `${data.split(sep).join('/')}/`;
    const paths = listing.files.filter(
      (path) => !(dataInside && `${path}/`.startsWith(dataPrefix)) && !/[\r\n]/.test(path),
    );
    const files: Candidate[] = [];
    const skipped: string[] = [];
    for (let at = 0; at < paths.length; at += STAT_BATCH) {
      const batch = paths.slice(at, at + STAT_BATCH);
      const stats = await Promise.all(
        batch.map((path) => fs.stat(join(base, path)).catch((): Stats | undefined => undefined)),
      );
      batch.forEach((path, index) => {
        const stat = stats[index];
        if (stat === undefined || !stat.isFile()) return;
        if (stat.size > CHECKPOINT_FILE_MAX_BYTES) {
          skipped.push(path);
          return;
        }
        const executable = process.platform !== 'win32' && (stat.mode & 0o111) !== 0;
        files.push({ path, mode: executable ? '100755' : '100644' });
      });
    }
    return { files, skipped: skipped.sort() };
  }

  /** Each file's blob id, written into the store as its bytes are on disk. */
  async function hashAll(gitDir: string, base: string, files: Candidate[]): Promise<string[]> {
    let list = files;
    for (let attempt = 0; ; attempt += 1) {
      if (list.length === 0) return [];
      const args = ['hash-object', '-w', '--no-filters', '--stdin-paths'];
      const result = await git(args, gitDir, {
        workTree: base,
        stdin: `${list.map((file) => pathLine(file.path)).join('\n')}\n`,
      });
      const ids = result.stdout
        .toString('utf8')
        .split('\n')
        .filter((line) => line !== '');
      if (result.code === 0 && ids.length === list.length) {
        files.splice(0, files.length, ...list);
        return ids;
      }
      // a file deleted between the listing and the hash: leave it out and hash again
      const gone = /could not open '(.+?)' for reading/.exec(result.stderr)?.[1];
      if (gone === undefined || attempt >= MAX_RETRIES) throw storeGitFailed(args, result);
      list = list.filter((file) => file.path !== gone);
    }
  }

  /** The blobs as one tree, through a temporary index nobody else reads. */
  async function writeTree(
    gitDir: string,
    files: Candidate[],
    ids: string[],
    skipped: string[],
  ): Promise<string> {
    const indexFile = join(gitDir, `ace-index-${randomBytes(8).toString('hex')}`);
    try {
      let entries = files.map((file, index) => ({ ...file, id: ids[index] ?? '' }));
      for (let attempt = 0; ; attempt += 1) {
        const args = ['update-index', '-z', '--index-info'];
        const result = await git(args, gitDir, {
          indexFile,
          stdin: entries.map((entry) => `${entry.mode} ${entry.id}\t${entry.path}\0`).join(''),
        });
        if (result.code === 0) break;
        // a name git will not hold (it says which): leave it out, report it, and try again
        const refused =
          /invalid path '(.+?)'/.exec(result.stderr)?.[1] ??
          /cannot add (.+?)\s*$/m.exec(result.stderr)?.[1];
        if (refused === undefined || attempt >= MAX_RETRIES) throw storeGitFailed(args, result);
        entries = entries.filter((entry) => entry.path !== refused);
        skipped.push(refused);
        await fs.rm(indexFile, { force: true });
      }
      return (await gitOk(['write-tree'], gitDir, { indexFile })).toString('utf8').trim();
    } finally {
      await fs.rm(indexFile, { force: true }).catch(() => undefined);
      await fs.rm(`${indexFile}.lock`, { force: true }).catch(() => undefined);
    }
  }

  async function fileAt(
    projectId: string,
    commit: string,
    path: string,
  ): Promise<Uint8Array | undefined> {
    assertCommit(commit);
    const gitDir = await storeOf(projectId);
    const object = `${commit}:${path}`;
    const type = await git(['cat-file', '-t', object], gitDir);
    if (type.code !== 0 || type.stdout.toString('utf8').trim() !== 'blob') return undefined;
    return new Uint8Array(await gitOk(['cat-file', 'blob', object], gitDir));
  }

  async function readDisk(absolute: string): Promise<Uint8Array | 'other' | undefined> {
    const stat = await fs.lstat(absolute).catch(() => undefined);
    if (stat === undefined) return undefined;
    if (!stat.isFile()) return 'other';
    return new Uint8Array(await fs.readFile(absolute));
  }

  return {
    async snapshot(projectId, root, target): Promise<SnapshotRef> {
      assertSafeName('checkpoint', target.checkpointId);
      const base = resolve(root);
      const folder = await fs.stat(base).catch(() => undefined);
      if (folder === undefined || !folder.isDirectory()) {
        throw unavailable('The project folder cannot be read.');
      }
      const gitDir = await storeOf(projectId);
      const { files, skipped } = await candidates(base);
      const ids = await hashAll(gitDir, base, files);
      const tree = await writeTree(gitDir, files, ids, skipped);
      const date = new Date().toISOString();
      const commit = (
        await gitOk(
          ['commit-tree', tree, '-m', `ACE checkpoint ${target.checkpointId} ${target.side}`],
          gitDir,
          {
            env: {
              GIT_AUTHOR_NAME: AUTHOR.name,
              GIT_AUTHOR_EMAIL: AUTHOR.email,
              GIT_AUTHOR_DATE: date,
              GIT_COMMITTER_NAME: AUTHOR.name,
              GIT_COMMITTER_EMAIL: AUTHOR.email,
              GIT_COMMITTER_DATE: date,
            },
          },
        )
      )
        .toString('utf8')
        .trim();
      await gitOk(['update-ref', `refs/ace/${target.checkpointId}/${target.side}`, commit], gitDir);
      return { commit, skipped: [...new Set(skipped)].sort() };
    },

    async diff(projectId, before, after): Promise<CheckpointFileDiffEntry[]> {
      assertCommit(before);
      assertCommit(after);
      const gitDir = await storeOf(projectId);
      const common = [
        'diff-tree',
        '-r',
        '--no-commit-id',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
      ];
      const [numstat, names] = await Promise.all([
        gitOk([...common, '--numstat', '-z', before, after], gitDir),
        gitOk([...common, '--name-status', '-z', before, after], gitDir),
      ]);
      const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
      for (const record of numstat.toString('utf8').split('\0')) {
        const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
        if (match === null) continue;
        const binary = match[1] === '-';
        counts.set(match[3] ?? '', {
          additions: binary ? 0 : Number(match[1]),
          deletions: binary ? 0 : Number(match[2]),
          binary,
        });
      }
      const fields = names.toString('utf8').split('\0');
      const files: CheckpointFileDiffEntry[] = [];
      for (let at = 0; at + 1 < fields.length; at += 2) {
        const status = fields[at] ?? '';
        const path = fields[at + 1] ?? '';
        if (status === '' || path === '') continue;
        const count = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
        files.push({ path, change: changeOf(status.charAt(0)), ...count });
      }
      return files;
    },

    fileAt,

    async revertFile(projectId, root, before, after, path): Promise<void> {
      const base = resolve(root);
      // confined, and never into .git or .ace (FR-GIT-008)
      const absolute = toAbsolute(base, path, { write: true });
      const rel = relative(base, absolute).split(sep).join('/');
      const [was, agentLeft, now] = await Promise.all([
        fileAt(projectId, before, rel),
        fileAt(projectId, after, rel),
        readDisk(absolute),
      ]);
      if (now === 'other' || !sameBytes(now, agentLeft)) throw new CheckpointConflictError(path);
      if (was === undefined) {
        if (now !== undefined) await fs.rm(absolute, { force: true });
        return;
      }
      await fs.mkdir(dirname(absolute), { recursive: true });
      const mode = now === undefined ? undefined : (await fs.stat(absolute)).mode;
      await atomicWrite(absolute, was, mode);
    },

    async drop(projectId, checkpointId): Promise<void> {
      assertSafeName('checkpoint', checkpointId);
      const gitDir = await storeOf(projectId);
      for (const side of ['before', 'after']) {
        await git(['update-ref', '-d', `refs/ace/${checkpointId}/${side}`], gitDir);
      }
    },
  };
}
