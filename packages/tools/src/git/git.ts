import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';

import type { GitPort, MergeResult, RepoStatus } from '@ace/engine';

import { isDirectory } from '../process/is-directory.js';
import { killProcessTree } from '../process/kill-tree.js';
import { mergeEnv, unsetEnv } from '../process/merge-env.js';
import { countStatusEntries, parseRawNumstat, splitNul } from './parse.js';

/**
 * A Git command that failed in a way the caller should show (D269). `message` is Git's own stderr,
 * trimmed — or, when Git could not be run at all, why not (`exitCode` is then `null`).
 */
export class GitError extends Error {
  /** The arguments Git was run with (everything after the binary). */
  readonly args: readonly string[];
  /** `null` when Git never ran (not installed, the folder is gone) or was killed. */
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    details: { args?: readonly string[]; exitCode?: number | null; stderr?: string } = {},
  ) {
    super(message);
    this.name = 'GitError';
    this.args = details.args ?? [];
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? '';
  }
}

export interface GitPortOptions {
  /** The Git binary; `git` on the PATH by default. */
  gitBinary?: string;
  /** Laid over the engine's environment for every Git call; a key set to `undefined` removes it. */
  env?: NodeJS.ProcessEnv;
  /**
   * How long one Git call may take before its process tree is killed and the call fails. A
   * repository's own hooks (`post-checkout`, `pre-merge-commit`) or a signing prompt could
   * otherwise hang a task forever. Default 5 minutes.
   */
  timeoutMs?: number;
}

const DEFAULT_GIT_TIMEOUT_MS = 300_000;

/**
 * ACE's own bookkeeping commits (the first commit of an initialised folder, a run's changes on a
 * task branch) are never signed: a signing prompt would block a run with nobody watching. A merge
 * into the user's branch keeps the user's own signing configuration — it is their history.
 */
const UNSIGNED = ['-c', 'commit.gpgsign=false'] as const;

/** The identity of ACE's own commits when the repository has none configured (D269). */
const FALLBACK_NAME = 'ACE';
const FALLBACK_EMAIL = 'ace@localhost';

/**
 * Variables that point Git at a different repository than the folder it runs in. They are set
 * while a Git hook runs (an engine started from one, a test run from a pre-commit hook) and would
 * silently redirect every call here, so they are never passed on.
 */
const REPOSITORY_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

/** What one Git call produced. `stdout` is raw bytes: paths and patches are decoded once, as UTF-8. */
interface GitRun {
  args: readonly string[];
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** `stdout` was cut at the caller's `maxStdout`. */
  truncated: boolean;
}

interface RunOptions {
  /** `-c key=value` pairs, placed before the subcommand. */
  config?: readonly string[];
  /** Pathspecs are file names, not patterns (`*`, `?`, `[`, `:(magic)` mean themselves). */
  literalPathspecs?: boolean;
  /** Keep at most this many bytes of stdout; the rest is read and dropped. */
  maxStdout?: number;
}

/**
 * The Git port (D269, FR-GIT-001/005) over the `git` binary on the machine.
 *
 * Every call is `spawn(git, [...args])` — an argument array, never a shell — with
 * `GIT_TERMINAL_PROMPT=0` (nothing can wait on a password prompt), `GIT_OPTIONAL_LOCKS=0` (reading
 * status never takes the index lock an agent's own `git` may want), `LC_ALL=C` (Git's messages are
 * the stable English ones) and `core.quotepath=off`. Paths are read from `-z` output, so a name
 * with spaces, quotes or non-ASCII characters comes back exactly as it is on disk.
 */
export function createGitPort(options: GitPortOptions = {}): GitPort {
  const binary = options.gitBinary ?? 'git';
  const env = gitEnvironment(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  const run = (
    cwd: string | undefined,
    args: readonly string[],
    runOptions: RunOptions = {},
  ): Promise<GitRun> =>
    exec(
      binary,
      env,
      [
        '-c',
        'core.quotepath=off',
        ...(runOptions.literalPathspecs === true ? ['--literal-pathspecs'] : []),
        ...(runOptions.config ?? []),
        ...args,
      ],
      cwd,
      runOptions.maxStdout,
      timeoutMs,
    );

  /** As `run`, but a non-zero exit is a `GitError`. */
  const check = async (
    cwd: string | undefined,
    args: readonly string[],
    runOptions: RunOptions = {},
  ): Promise<GitRun> => {
    const result = await run(cwd, args, runOptions);
    if (result.code !== 0) throw failure(result);
    return result;
  };

  const available = async (): Promise<boolean> => {
    try {
      return (await run(undefined, ['--version'])).code === 0;
    } catch {
      return false;
    }
  };

  /** The checked-out branch, or `null` on a detached HEAD. */
  const currentBranch = async (cwd: string): Promise<string | null> => {
    const result = await run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (result.code === 0) return text(result).trim();
    if (result.code === 1) return null;
    throw failure(result);
  };

  const headSha = async (cwd: string): Promise<string> => {
    const result = await run(cwd, ['rev-parse', '-q', '--verify', 'HEAD']);
    const sha = text(result).trim();
    if (result.code !== 0 || sha === '') {
      throw new GitError(result.stderr.trim() || `${cwd} has no commit yet.`, {
        args: result.args,
        exitCode: result.code,
        stderr: result.stderr,
      });
    }
    return sha;
  };

  const branchExists = async (repoPath: string, branch: string): Promise<boolean> => {
    assertRevision('branch', branch);
    const result = await run(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw failure(result);
  };

  const hasRevision = async (cwd: string, revision: string): Promise<boolean> =>
    (await run(cwd, ['rev-parse', '-q', '--verify', revision])).code === 0;

  /** `-c user.name=… -c user.email=…` for whichever half of the identity is not configured. */
  const identity = async (cwd: string): Promise<string[]> => {
    const [name, email] = await Promise.all([
      run(cwd, ['config', 'user.name']),
      run(cwd, ['config', 'user.email']),
    ]);
    const config: string[] = [];
    if (text(name).trim() === '') config.push('-c', `user.name=${FALLBACK_NAME}`);
    if (text(email).trim() === '') config.push('-c', `user.email=${FALLBACK_EMAIL}`);
    return config;
  };

  /**
   * Records every untracked file as intent-to-add, so a diff against the working tree shows new
   * files too. Tracked files' staged content is left as it is.
   */
  const markUntracked = async (cwd: string): Promise<void> => {
    await check(cwd, ['add', '-A', '--intent-to-add']);
  };

  /** The revisions a diff compares: base → working tree, or base → head ref (HEAD by default). */
  const diffRange = (input: {
    baseSha: string;
    includeUncommitted: boolean;
    headRef?: string;
  }): string[] => {
    assertRevision('base', input.baseSha);
    if (input.includeUncommitted) return [input.baseSha];
    const head = input.headRef ?? 'HEAD';
    assertRevision('head', head);
    return [input.baseSha, head];
  };

  const inspect = async (folder: string): Promise<RepoStatus> => {
    if (!(await isDirectory(folder))) return { gitAvailable: await available(), isRepo: false };

    let top: GitRun;
    try {
      top = await run(folder, ['rev-parse', '--is-inside-work-tree', '--show-prefix']);
    } catch (error) {
      if (error instanceof GitError) return { gitAvailable: false, isRepo: false };
      throw error;
    }
    // A repository *here*, not a folder somewhere inside one: inside a work tree, with no prefix
    // between its top level and this folder.
    const [inside, prefix] = text(top).split(/\r?\n/);
    if (top.code !== 0 || inside !== 'true' || prefix !== '') {
      return { gitAvailable: true, isRepo: false };
    }

    const [branch, head, status, remote] = await Promise.all([
      currentBranch(folder),
      run(folder, ['rev-parse', '-q', '--verify', 'HEAD']),
      check(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=no']),
      run(folder, ['remote', 'get-url', 'origin']),
    ]);
    const changedFiles = countStatusEntries(text(status));
    const result: RepoStatus = {
      gitAvailable: true,
      isRepo: true,
      branch,
      clean: changedFiles === 0,
      changedFiles,
    };
    const sha = text(head).trim();
    if (head.code === 0 && sha !== '') result.headSha = sha;
    const url = text(remote).trim();
    if (remote.code === 0 && url !== '') result.remoteUrl = withoutCredentials(url);
    return result;
  };

  return {
    inspect,

    async init(folder) {
      if (!(await isDirectory(folder))) {
        throw new GitError(`The folder ${folder} does not exist.`);
      }
      const status = await inspect(folder);
      if (!status.gitAvailable) throw new GitError('Git is not installed, or it could not be run.');
      // A `.git` that Git would not open (another owner's repository, say) still makes it one: never
      // re-initialise over it.
      if (status.isRepo || (await pathExists(join(folder, '.git')))) {
        throw new GitError(`${folder} is already a Git repository.`);
      }

      const created = await run(folder, ['init', '-q', '-b', 'main']);
      if (created.code !== 0) {
        // Git before 2.28 has no `init -b`.
        await check(folder, ['init', '-q']);
        await check(folder, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      }
      await check(folder, ['add', '-A']);
      await check(
        folder,
        ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'Initial commit'],
        {
          config: [...UNSIGNED, ...(await identity(folder))],
        },
      );
      return inspect(folder);
    },

    branchExists,

    async createWorktree({ repoPath, worktreePath, branch, baseRef }) {
      assertRevision('branch', branch);
      assertRevision('base', baseRef);
      const base = await run(repoPath, ['rev-parse', '-q', '--verify', `${baseRef}^{commit}`]);
      const baseSha = text(base).trim();
      if (base.code !== 0 || baseSha === '') {
        throw new GitError(base.stderr.trim() || `${baseRef} is not a commit in ${repoPath}.`, {
          args: base.args,
          exitCode: base.code,
          stderr: base.stderr,
        });
      }
      // Started at the resolved commit rather than the ref, so the base reported is exactly the
      // one the worktree has even if the ref moves meanwhile.
      await check(repoPath, ['worktree', 'add', '-b', branch, resolvePath(worktreePath), baseSha]);
      return { baseSha };
    },

    async removeWorktree({ repoPath, worktreePath, deleteBranch }) {
      if (deleteBranch !== undefined) assertRevision('branch', deleteBranch);
      const path = resolvePath(worktreePath);
      if (await isDirectory(path)) {
        const removed = await run(repoPath, ['worktree', 'remove', '--force', path]);
        if (removed.code !== 0) {
          await run(repoPath, ['worktree', 'prune']);
          if (await isDirectory(path)) throw failure(removed);
        }
      } else {
        // Already gone from disk: forget Git's record of it, if it has one.
        await check(repoPath, ['worktree', 'prune']);
      }
      if (deleteBranch !== undefined && (await branchExists(repoPath, deleteBranch))) {
        await check(repoPath, ['branch', '-D', deleteBranch]);
      }
    },

    async commitAll({ cwd, message }) {
      await check(cwd, ['add', '-A']);
      const staged = await run(cwd, ['diff', '--cached', '--quiet', '--no-ext-diff']);
      if (staged.code === 0) return null;
      if (staged.code !== 1) throw failure(staged);
      await check(cwd, ['commit', '-q', '--no-verify', '-m', message], {
        config: [...UNSIGNED, ...(await identity(cwd))],
      });
      return { sha: await headSha(cwd) };
    },

    headSha,

    async changes(input) {
      const range = diffRange(input);
      if (input.includeUncommitted) await markUntracked(input.cwd);
      const [diff, status] = await Promise.all([
        check(input.cwd, [
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--raw',
          '--numstat',
          '-z',
          '-M',
          ...range,
          '--',
        ]),
        check(input.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      ]);
      return { files: parseRawNumstat(text(diff)), uncommitted: text(status) !== '' };
    },

    async fileDiff(input) {
      const range = diffRange(input);
      if (input.includeUncommitted) await markUntracked(input.cwd);
      // A rename is only seen as one when both of its paths are in the pathspec.
      const listed = await check(input.cwd, [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--raw',
        '-z',
        '-M',
        ...range,
        '--',
      ]);
      const oldPath = parseRawNumstat(text(listed)).find(
        (file) => file.path === input.path && file.status === 'renamed',
      )?.oldPath;
      const paths = oldPath === undefined ? [input.path] : [oldPath, input.path];

      const diff = await check(
        input.cwd,
        ['diff', '--no-color', '--no-ext-diff', '-M', ...range, '--', ...paths],
        { literalPathspecs: true, maxStdout: Math.max(0, input.maxBytes) },
      );
      const patch = utf8Prefix(diff.stdout).toString('utf8');
      return {
        patch,
        truncated: diff.truncated,
        binary: /^Binary files .* differ$/m.test(patch),
      };
    },

    async merge({ repoPath, branch, expectedBranch, message }): Promise<MergeResult> {
      assertRevision('branch', branch);
      const current = await currentBranch(repoPath);
      if (current !== expectedBranch) {
        return {
          ok: false,
          reason: 'wrong_branch',
          message:
            current === null
              ? `The folder is on a detached HEAD, not on ${expectedBranch}.`
              : `The folder is on ${current}, not on ${expectedBranch}.`,
        };
      }
      const status = await check(repoPath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=no',
      ]);
      const dirty = countStatusEntries(text(status));
      if (dirty > 0) {
        return {
          ok: false,
          reason: 'dirty',
          message: `The folder has uncommitted changes to ${dirty} tracked file${dirty === 1 ? '' : 's'}. Commit or stash them first.`,
        };
      }
      // Never abort a merge that someone else started.
      if (await hasRevision(repoPath, 'MERGE_HEAD')) {
        return {
          ok: false,
          reason: 'failed',
          message: 'A merge is already in progress in the folder.',
        };
      }

      const merged = await run(repoPath, ['merge', '--no-ff', '--no-edit', '-m', message, branch], {
        config: await identity(repoPath),
      });
      if (merged.code === 0) return { ok: true, sha: await headSha(repoPath) };

      const unmerged = await run(repoPath, ['diff', '--name-only', '--diff-filter=U', '-z']);
      const conflicts = unmerged.code === 0 ? splitNul(text(unmerged)) : [];
      if (await hasRevision(repoPath, 'MERGE_HEAD')) {
        await check(repoPath, ['merge', '--abort']);
      }
      if (conflicts.length > 0) {
        return {
          ok: false,
          reason: 'conflict',
          conflicts,
          message: `Merging ${branch} into ${expectedBranch} conflicts in ${conflicts.join(', ')}. The merge was aborted; the folder is unchanged.`,
        };
      }
      return {
        ok: false,
        reason: 'failed',
        message:
          merged.stderr.trim() ||
          text(merged).trim() ||
          `git merge exited with code ${String(merged.code)}.`,
      };
    },
  };
}

/** The engine's environment, minus anything that redirects Git, plus the settings every call needs. */
function gitEnvironment(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env = mergeEnv(process.env, overrides);
  for (const name of REPOSITORY_VARIABLES) unsetEnv(env, name);
  for (const [name, value] of [
    ['GIT_TERMINAL_PROMPT', '0'],
    ['GIT_OPTIONAL_LOCKS', '0'],
    ['LC_ALL', 'C'],
  ] as const) {
    unsetEnv(env, name);
    env[name] = value;
  }
  return env;
}

function exec(
  binary: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  cwd: string | undefined,
  maxStdout: number | undefined,
  timeoutMs: number,
): Promise<GitRun> {
  return new Promise<GitRun>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      void describeSpawnFailure(error, cwd).then((message) =>
        reject(new GitError(message, { args, exitCode: null })),
      );
    };

    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      fail(error);
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let kept = 0;
    let total = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (maxStdout === undefined) {
        out.push(chunk);
        return;
      }
      const room = maxStdout - kept;
      if (room <= 0) return;
      const piece = chunk.length <= room ? chunk : chunk.subarray(0, room);
      out.push(piece);
      kept += piece.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
      reject(
        new GitError(
          `git ${args.join(' ')} did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped.`,
          { args, exitCode: null, stderr: Buffer.concat(err).toString('utf8') },
        ),
      );
    }, timeoutMs);
    timer.unref();
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        args,
        code,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString('utf8'),
        truncated: maxStdout !== undefined && total > maxStdout,
      });
    });
  });
}

async function describeSpawnFailure(error: unknown, cwd: string | undefined): Promise<string> {
  // Node reports a missing working folder as the binary being missing (`spawn git ENOENT`).
  if (cwd !== undefined && !(await isDirectory(cwd))) return `The folder ${cwd} does not exist.`;
  const reason = error instanceof Error ? error.message : String(error);
  return `Git could not be run (${reason}). Is it installed and on the PATH?`;
}

function failure(result: GitRun): GitError {
  return new GitError(
    result.stderr.trim() ||
      text(result).trim() ||
      `git ${result.args.join(' ')} exited with code ${String(result.code)}.`,
    { args: result.args, exitCode: result.code, stderr: result.stderr },
  );
}

function text(result: GitRun): string {
  return result.stdout.toString('utf8');
}

/**
 * A branch, ref or commit given to Git as an argument. One that starts with `-` would be read as an
 * option, so it is refused rather than passed on.
 */
function assertRevision(kind: string, value: string): void {
  if (value === '' || value.startsWith('-')) {
    throw new GitError(`Invalid ${kind}: "${value}".`);
  }
}

/** Drops an `https://user:token@` prefix's credentials, so a URL is safe to show or store (BR-07). */
function withoutCredentials(url: string): string {
  return url.replace(/^(https?:\/\/)[^@/]*@/i, '$1');
}

/** The longest prefix of `bytes` that does not end inside a UTF-8 sequence. */
function utf8Prefix(bytes: Buffer): Buffer {
  const end = bytes.length;
  let lead = end - 1;
  // Step back over continuation bytes (10xxxxxx) to the start of the last character.
  while (lead >= 0 && end - lead <= 4 && ((bytes[lead] ?? 0) & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return bytes;
  const first = bytes[lead] ?? 0;
  const length = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return lead + length > end ? bytes.subarray(0, lead) : bytes;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
