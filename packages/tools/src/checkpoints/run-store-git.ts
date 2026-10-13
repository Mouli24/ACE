import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { CheckpointUnavailableError } from '@ace/engine';

/*
 * git for the private checkpoint store (D300, design §5.1) — not `runGit`, whose inherited
 * environment, global config and output caps fit the project's own repository, not this one.
 * Argument arrays only, no shell; the system and global config, hooks, fsmonitor, line-ending
 * conversion and auto-gc are all off; every inherited `GIT_*` variable is dropped, so a stray
 * `GIT_DIR` can never point a snapshot at the person's repository.
 */

/** The empty file standing in for the global config (`NUL` does not work on Windows). */
export const STORE_GLOBAL_CONFIG = 'ace-empty-gitconfig';
export const STORE_GIT_TIMEOUT_MS = 60_000;
export const STORE_GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** How long a killed command may take to exit before it is answered regardless. */
export const STORE_GIT_KILL_GRACE_MS = 2_000;

/** Ahead of every command: nothing configured anywhere may run a program or rewrite bytes. */
const SAFE_CONFIG = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.hooksPath=',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'gc.auto=0',
] as const;

export interface StoreGitOptions {
  /** The store, `GIT_DIR`. */
  gitDir: string;
  /** The project folder, `GIT_WORK_TREE`; also the working directory when given. */
  workTree?: string;
  /** A per-call `GIT_INDEX_FILE`. */
  indexFile?: string;
  /** Extra variables, set after the inherited `GIT_*` ones are dropped (an author, a date). */
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  /** Tests: never end stdin, to prove the timeout. */
  keepStdinOpen?: boolean;
  timeoutMs?: number;
  /** The git binary; tests name one that does not exist. */
  git?: string;
}

export interface StoreGitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** The inherited environment minus every `GIT_*` variable, plus the store's own. */
function storeEnv(options: StoreGitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toUpperCase().startsWith('GIT_')) env[name] = value;
  }
  return {
    ...env,
    GIT_DIR: options.gitDir,
    ...(options.workTree === undefined ? {} : { GIT_WORK_TREE: options.workTree }),
    ...(options.indexFile === undefined ? {} : { GIT_INDEX_FILE: options.indexFile }),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(options.gitDir, STORE_GLOBAL_CONFIG),
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    ...options.env,
  };
}

/**
 * Runs one git command against the store. Resolves with the exit code, stdout as bytes (capped at
 * 64 MB — more rejects rather than truncating) and the tail of stderr. Rejects with
 * `CheckpointUnavailableError('git_missing')` when git is not installed, and after 60 s.
 *
 * A command killed for its time or its output is answered only once it has exited (D300 G-1): until
 * then git holds files in the store, and on Windows an open file blocks deleting its folder. Should
 * the exit never be reported, it is answered {@link STORE_GIT_KILL_GRACE_MS} after the kill anyway.
 */
export function runStoreGit(
  args: readonly string[],
  options: StoreGitOptions,
): Promise<StoreGitResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    /** Why the command was killed: the answer once it has exited. */
    let killedFor: Error | undefined;
    let grace: NodeJS.Timeout | undefined;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      outcome();
    };
    const child = spawn(options.git ?? 'git', [...SAFE_CONFIG, ...args], {
      cwd: options.workTree ?? options.gitDir,
      env: storeEnv(options),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const kill = (reason: Error): void => {
      if (settled || killedFor !== undefined) return;
      killedFor = reason;
      clearTimeout(timer);
      child.kill('SIGKILL');
      // nothing more goes in: whatever still reads the pipe sees its end
      child.stdin.destroy();
      grace = setTimeout(() => finish(() => reject(reason)), STORE_GIT_KILL_GRACE_MS);
    };
    const timer = setTimeout(
      () => kill(new CheckpointUnavailableError('failed', `git ${args[0] ?? ''} timed out.`)),
      options.timeoutMs ?? STORE_GIT_TIMEOUT_MS,
    );

    child.stdout.on('data', (chunk: Buffer) => {
      if (killedFor !== undefined) return;
      size += chunk.length;
      if (size > STORE_GIT_MAX_OUTPUT_BYTES) {
        chunks.length = 0;
        kill(new CheckpointUnavailableError('failed', `git ${args[0] ?? ''} answered too much.`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      // a kill that failed: the exit, or the grace period, still decides
      if (killedFor !== undefined) return;
      finish(() =>
        reject(
          error.code === 'ENOENT'
            ? new CheckpointUnavailableError('git_missing', 'git is not installed or not on PATH.')
            : new CheckpointUnavailableError('failed', `git could not run: ${error.message}`),
        ),
      );
    });
    child.on('close', (code) =>
      finish(() =>
        killedFor === undefined
          ? resolve({ code, stdout: Buffer.concat(chunks), stderr })
          : reject(killedFor),
      ),
    );
    // A command that exits before reading its input closes the pipe; that is not an error here.
    child.stdin.on('error', () => undefined);
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    if (options.keepStdinOpen !== true) child.stdin.end();
  });
}

/** A failed command as an error, with the end of what git said. */
export function storeGitFailed(args: readonly string[], result: StoreGitResult): Error {
  return new CheckpointUnavailableError(
    'failed',
    `git ${args[0] ?? ''} exited ${result.code ?? 'by signal'}: ${result.stderr.trim().slice(-500)}`,
  );
}
