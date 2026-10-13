import { randomBytes } from 'node:crypto';
import { promises as fs, readFileSync, type Dirent, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { CheckpointFileChange, CheckpointUncapturedReason } from '@ace/contracts';
import {
  CheckpointConflictError,
  CheckpointUnavailableError,
  uncapturedMessage,
  type CheckpointFileDiffEntry,
  type CheckpointStore,
  type SnapshotRef,
} from '@ace/engine';

import { SAVE_TEMP_SUFFIX, atomicWrite } from '../workspace/fs-files.js';
import { createIgnoreRules, type IgnoreRules } from '../workspace/ignore-rules.js';
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
 *
 * Every snapshot also records a manifest: each existing path it left out and why (ignored, over
 * 5 MB, unreadable, vanished), and the `.gitignore` texts it judged by. The after snapshot judges
 * by the before snapshot's texts, so a `.gitignore` the agent edits never makes a file look added
 * or deleted; and a revert deletes a file only on proof — absent from the before tree and not in
 * its manifest. A path either manifest names is never reverted (D300 fix C1).
 */

/** A file over this is left out of a snapshot and reported as skipped. */
export const CHECKPOINT_FILE_MAX_BYTES = 5 * 1024 * 1024;
/** The most files one snapshot covers; a bigger folder fails the checkpoint, honestly. */
export const SNAPSHOT_FILE_LIMIT = 200_000;
/** Files stat'ed at once while listing. */
const STAT_BATCH = 64;
/** A file that vanishes, or a name git refuses, is left out and the step retried this often. */
const MAX_RETRIES = 50;

const AUTHOR = { name: 'ACE', email: 'ace@localhost' };
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
const MANIFEST_LINE = /^manifest ([0-9a-f]{40,64})$/m;
const BATCH_HEADER = /^([0-9a-f]{40,64}) (\S+) (\d+)$/;

export interface GitCheckpointStoreOptions {
  /** The git binary; tests name one that does not exist. */
  git?: string;
  /** The most files a snapshot covers (default {@link SNAPSHOT_FILE_LIMIT}). */
  maxFiles?: number;
  /** Tests: runs once a snapshot has listed the folder, before it reads any file. */
  onListed?: (paths: readonly string[]) => void | Promise<void>;
}

interface Candidate {
  path: string;
  mode: '100644' | '100755';
}

/** An existing path a snapshot left out; a `folder` covers everything under it. */
interface Omission {
  path: string;
  reason: CheckpointUncapturedReason;
  folder?: true;
}

/** Stored as a blob beside each snapshot commit (`manifest <id>` in its message). */
interface Manifest {
  version: 1;
  /** Folder → its `.gitignore` text, as the before snapshot read it. */
  gitignores: Array<[folder: string, text: string]>;
  omitted: Omission[];
}

/** One side of a checkpoint as a revert needs it: the file's blob, and what the side left out. */
interface Side {
  blob: Buffer | undefined;
  manifest: Manifest | undefined;
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

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Why `path` was left out of the snapshot this manifest describes, if it was. */
function omissionOf(
  manifest: Manifest | undefined,
  path: string,
): CheckpointUncapturedReason | undefined {
  for (const omitted of manifest?.omitted ?? []) {
    if (omitted.path === path) return omitted.reason;
    if (omitted.folder === true && path.startsWith(`${omitted.path}/`)) return omitted.reason;
  }
  return undefined;
}

export function createGitCheckpointStore(
  dataDir: string,
  options: GitCheckpointStoreOptions = {},
): CheckpointStore {
  const ready = new Map<string, Promise<string>>();
  const maxFiles = options.maxFiles ?? SNAPSHOT_FILE_LIMIT;
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

  /**
   * Objects by name (`<commit>` or `<commit>:<path>`), through one `cat-file --batch`: each is its
   * type and bytes, or `undefined` when git says it is missing — a positive answer, never a guess.
   */
  async function readObjects(
    gitDir: string,
    specs: readonly string[],
  ): Promise<Array<{ type: string; bytes: Buffer } | undefined>> {
    const out = await gitOk(['cat-file', '--batch'], gitDir, {
      stdin: specs.map((spec) => `${spec}\n`).join(''),
    });
    const found: Array<{ type: string; bytes: Buffer } | undefined> = [];
    let at = 0;
    for (const spec of specs) {
      const end = out.indexOf(0x0a, at);
      if (end === -1) throw unavailable('The checkpoint store answered too little.');
      const header = out.subarray(at, end).toString('utf8');
      const match = BATCH_HEADER.exec(header);
      if (match === null) {
        if (header !== `${spec} missing` && header !== `${spec} ambiguous`) {
          throw unavailable('The checkpoint store answered something unreadable.');
        }
        found.push(undefined);
        at = end + 1;
        continue;
      }
      const size = Number(match[3]);
      found.push({ type: match[2] ?? '', bytes: out.subarray(end + 1, end + 1 + size) });
      at = end + 1 + size + 1;
    }
    return found;
  }

  /** The manifest a snapshot commit names; `undefined` for a snapshot made before manifests. */
  async function manifestOf(gitDir: string, commit: Buffer): Promise<Manifest | undefined> {
    const id = MANIFEST_LINE.exec(commit.toString('utf8'))?.[1];
    if (id === undefined) return undefined;
    const [blob] = await readObjects(gitDir, [id]);
    if (blob === undefined) throw unavailable('A checkpoint manifest is missing from the store.');
    return JSON.parse(blob.bytes.toString('utf8')) as Manifest;
  }

  /** One side of a checkpoint for `path`. An unknown commit is an error, never "absent". */
  async function sideOf(gitDir: string, commit: string, path: string): Promise<Side> {
    assertCommit(commit);
    const [head, file] = await readObjects(gitDir, [commit, `${commit}:${path}`]);
    if (head === undefined || head.type !== 'commit') {
      throw unavailable('That checkpoint commit is not in the store.');
    }
    return {
      blob: file?.type === 'blob' ? file.bytes : undefined,
      manifest: await manifestOf(gitDir, head.bytes),
    };
  }

  /** The `.gitignore` texts the before snapshot of `checkpointId` judged by. */
  async function beforeRules(gitDir: string, checkpointId: string): Promise<Map<string, string>> {
    const [head] = await readObjects(gitDir, [`refs/ace/${checkpointId}/before`]);
    const manifest = head?.type === 'commit' ? await manifestOf(gitDir, head.bytes) : undefined;
    if (manifest === undefined) {
      throw unavailable('The before snapshot of this checkpoint is missing.');
    }
    return new Map(manifest.gitignores);
  }

  /**
   * The folder as the snapshot sees it: every file to capture, and every existing path it leaves
   * out and why — ignored folders as one entry each. Never more than `maxFiles` files: a bigger
   * folder fails the checkpoint rather than covering part of it (D300 fix I1).
   */
  async function listTree(
    base: string,
    rules: IgnoreRules,
  ): Promise<{ files: string[]; omitted: Omission[] }> {
    // the data dir inside the project folder must never snapshot its own store
    const data = relative(base, resolve(dataDir)).split(sep).join('/');
    const dataInside = data !== '' && !data.startsWith('..') && !isAbsolute(data);
    const files: string[] = [];
    const omitted: Omission[] = [];
    const queue: string[] = [''];
    for (let next = 0; next < queue.length; next += 1) {
      const folder = queue[next] ?? '';
      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(join(base, folder), { withFileTypes: true });
      } catch (error) {
        if (folder === '') throw unavailable('The project folder cannot be read.');
        omitted.push({
          path: folder,
          reason: isMissing(error) ? 'vanished' : 'unreadable',
          folder: true,
        });
        continue;
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const dirent of dirents) {
        if (dirent.name.endsWith(SAVE_TEMP_SUFFIX)) continue;
        const rel = folder === '' ? dirent.name : `${folder}/${dirent.name}`;
        // .git is never captured and never written: no revert can reach it
        if (rules.isHidden(rel)) continue;
        if (dirent.isDirectory()) {
          if ((dataInside && rel === data) || rules.isIgnored(rel, true)) {
            omitted.push({ path: rel, reason: 'ignored', folder: true });
          } else {
            queue.push(rel);
          }
          continue;
        }
        // a link (to a file or a folder) is never followed, and so never captured; as a folder
        // entry it also covers what sits under its name, should the agent swap it for a folder
        if (!dirent.isFile() || /[\r\n]/.test(rel)) {
          omitted.push({ path: rel, reason: 'unreadable', folder: true });
          continue;
        }
        if (rules.isIgnored(rel, false)) {
          omitted.push({ path: rel, reason: 'ignored' });
          continue;
        }
        files.push(rel);
        if (files.length > maxFiles) {
          throw unavailable(
            `project too large for checkpoints (over ${maxFiles.toLocaleString('en-US')} files)`,
          );
        }
      }
    }
    return { files, omitted };
  }

  /** The files to hash with their modes; too large, gone or not a file goes in the manifest. */
  async function candidates(
    base: string,
    paths: readonly string[],
    omitted: Omission[],
  ): Promise<{ files: Candidate[]; skipped: string[] }> {
    const files: Candidate[] = [];
    const skipped: string[] = [];
    for (let at = 0; at < paths.length; at += STAT_BATCH) {
      const batch = paths.slice(at, at + STAT_BATCH);
      const stats = await Promise.all(
        batch.map((path) =>
          fs.lstat(join(base, path)).then(
            (stat): Stats | 'vanished' | 'unreadable' => stat,
            (error: unknown) => (isMissing(error) ? 'vanished' : 'unreadable'),
          ),
        ),
      );
      batch.forEach((path, index) => {
        const stat = stats[index] ?? 'unreadable';
        if (stat === 'vanished' || stat === 'unreadable') {
          omitted.push({ path, reason: stat });
        } else if (!stat.isFile()) {
          omitted.push({ path, reason: 'unreadable' });
        } else if (stat.size > CHECKPOINT_FILE_MAX_BYTES) {
          omitted.push({ path, reason: 'too_large' });
          skipped.push(path);
        } else {
          const executable = process.platform !== 'win32' && (stat.mode & 0o111) !== 0;
          files.push({ path, mode: executable ? '100755' : '100644' });
        }
      });
    }
    return { files, skipped: skipped.sort() };
  }

  /**
   * Each file's blob id, written into the store as its bytes are on disk. A file git cannot open
   * — gone since the listing, or locked — goes in the manifest, and the rest are hashed again.
   */
  async function hashAll(
    gitDir: string,
    base: string,
    candidates: Candidate[],
    omitted: Omission[],
  ): Promise<{ files: Candidate[]; ids: string[] }> {
    let files = candidates;
    for (let attempt = 0; ; attempt += 1) {
      if (files.length === 0) return { files, ids: [] };
      const args = ['hash-object', '-w', '--no-filters', '--stdin-paths'];
      const result = await git(args, gitDir, {
        workTree: base,
        stdin: `${files.map((file) => pathLine(file.path)).join('\n')}\n`,
      });
      const ids = result.stdout
        .toString('utf8')
        .split('\n')
        .filter((line) => line !== '');
      if (result.code === 0 && ids.length === files.length) return { files, ids };
      const failed = /could not open '(.+?)' for reading/.exec(result.stderr)?.[1];
      if (failed === undefined || attempt >= MAX_RETRIES) throw storeGitFailed(args, result);
      const gone = await fs.lstat(join(base, failed)).then(
        () => false,
        (error: unknown) => isMissing(error),
      );
      omitted.push({ path: failed, reason: gone ? 'vanished' : 'unreadable' });
      files = files.filter((file) => file.path !== failed);
    }
  }

  /** The blobs as one tree, through a temporary index nobody else reads. */
  async function writeTree(
    gitDir: string,
    files: readonly Candidate[],
    ids: readonly string[],
    omitted: Omission[],
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
        // a name git will not hold (it says which): leave it out, record it, and try again
        const refused =
          /invalid path '(.+?)'/.exec(result.stderr)?.[1] ??
          /cannot add (.+?)\s*$/m.exec(result.stderr)?.[1];
        if (refused === undefined || attempt >= MAX_RETRIES) throw storeGitFailed(args, result);
        entries = entries.filter((entry) => entry.path !== refused);
        omitted.push({ path: refused, reason: 'unreadable' });
        await fs.rm(indexFile, { force: true });
      }
      return (await gitOk(['write-tree'], gitDir, { indexFile })).toString('utf8').trim();
    } finally {
      await fs.rm(indexFile, { force: true }).catch(() => undefined);
      await fs.rm(`${indexFile}.lock`, { force: true }).catch(() => undefined);
    }
  }

  async function readDisk(
    absolute: string,
  ): Promise<{ bytes: Uint8Array; mode: number } | 'other' | undefined> {
    const stat = await fs.lstat(absolute).catch(() => undefined);
    if (stat === undefined) return undefined;
    if (!stat.isFile()) return 'other';
    return { bytes: new Uint8Array(await fs.readFile(absolute)), mode: stat.mode };
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

      // before: read each .gitignore and record it; after: judge by exactly those texts
      const recorded =
        target.side === 'after' ? await beforeRules(gitDir, target.checkpointId) : undefined;
      const gitignores = recorded ?? new Map<string, string>();
      const rules = createIgnoreRules(base, (folderPath) => {
        if (recorded !== undefined) return recorded.get(folderPath) ?? null;
        let text: string;
        try {
          text = readFileSync(join(base, folderPath, '.gitignore'), 'utf8');
        } catch {
          return null;
        }
        gitignores.set(folderPath, text);
        return text;
      });

      const listing = await listTree(base, rules);
      await options.onListed?.(listing.files);
      const { omitted } = listing;
      const { files, skipped } = await candidates(base, listing.files, omitted);
      const hashed = await hashAll(gitDir, base, files, omitted);
      const tree = await writeTree(gitDir, hashed.files, hashed.ids, omitted);

      const manifest: Manifest = { version: 1, gitignores: [...gitignores], omitted };
      const manifestId = (
        await gitOk(['hash-object', '-w', '--no-filters', '--stdin'], gitDir, {
          stdin: JSON.stringify(manifest),
        })
      )
        .toString('utf8')
        .trim();
      const date = new Date().toISOString();
      const commit = (
        await gitOk(
          [
            'commit-tree',
            tree,
            '-m',
            `ACE checkpoint ${target.checkpointId} ${target.side}`,
            '-m',
            `manifest ${manifestId}`,
          ],
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
      const ref = `refs/ace/${target.checkpointId}/${target.side}`;
      await gitOk(['update-ref', ref, commit], gitDir);
      // the manifest is pinned beside its commit, so it lives exactly as long
      await gitOk(['update-ref', `${ref}-manifest`, manifestId], gitDir);
      return { commit, skipped };
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
      const [numstat, names, heads] = await Promise.all([
        gitOk([...common, '--numstat', '-z', before, after], gitDir),
        gitOk([...common, '--name-status', '-z', before, after], gitDir),
        readObjects(gitDir, [before, after]),
      ]);
      const [beforeHead, afterHead] = heads;
      if (beforeHead?.type !== 'commit' || afterHead?.type !== 'commit') {
        throw unavailable('That checkpoint commit is not in the store.');
      }
      const [beforeManifest, afterManifest] = await Promise.all([
        manifestOf(gitDir, beforeHead.bytes),
        manifestOf(gitDir, afterHead.bytes),
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
        // a side that left the path out is no proof of what it was: never revertible
        const uncaptured = omissionOf(beforeManifest, path) ?? omissionOf(afterManifest, path);
        files.push({
          path,
          change: changeOf(status.charAt(0)),
          ...count,
          ...(uncaptured === undefined ? {} : { uncaptured }),
        });
      }
      return files;
    },

    async fileAt(projectId, commit, path): Promise<Uint8Array | undefined> {
      const gitDir = await storeOf(projectId);
      const side = await sideOf(gitDir, commit, path);
      return side.blob === undefined ? undefined : new Uint8Array(side.blob);
    },

    async revertFile(projectId, root, before, after, path): Promise<void> {
      const base = resolve(root);
      // confined, and never into .git or .ace (FR-GIT-008)
      const absolute = toAbsolute(base, path, { write: true });
      const rel = relative(base, absolute).split(sep).join('/');
      const gitDir = await storeOf(projectId);

      // First everything git knows — the slow part — so nothing slow sits between reading the
      // disk and writing it (D300 fix I2).
      const [was, agentLeft] = await Promise.all([
        sideOf(gitDir, before, rel),
        sideOf(gitDir, after, rel),
      ]);
      const uncaptured = omissionOf(was.manifest, rel) ?? omissionOf(agentLeft.manifest, rel);
      if (uncaptured !== undefined) {
        throw new CheckpointConflictError(path, uncapturedMessage(path, uncaptured));
      }
      // "the agent created it" needs proof: absent from the before tree, and its manifest says
      // the snapshot saw everything else; a snapshot from before manifests proves nothing
      if (was.blob === undefined && was.manifest === undefined) {
        throw new CheckpointConflictError(path, uncapturedMessage(path, 'unreadable'));
      }

      // Then the disk, compared and written at once. A write that lands between this read and
      // the rename below is still overwritten: only an OS lock could close that window, and
      // nothing slow runs inside it.
      const now = await readDisk(absolute);
      if (now === 'other' || !sameBytes(now?.bytes, agentLeft.blob)) {
        throw new CheckpointConflictError(path);
      }
      if (was.blob === undefined) {
        if (now !== undefined) await fs.rm(absolute, { force: true });
        return;
      }
      await fs.mkdir(dirname(absolute), { recursive: true });
      await atomicWrite(absolute, was.blob, now?.mode);
    },

    async drop(projectId, checkpointId): Promise<void> {
      assertSafeName('checkpoint', checkpointId);
      const gitDir = await storeOf(projectId);
      for (const ref of ['before', 'after', 'before-manifest', 'after-manifest']) {
        await git(['update-ref', '-d', `refs/ace/${checkpointId}/${ref}`], gitDir);
      }
    },
  };
}
