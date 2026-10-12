import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

import type { ProcessStream } from '@ace/contracts';
import {
  WorkspaceFsError,
  type ProcessHandlers,
  type ProcessRunner,
  type RunningProcess,
} from '@ace/engine';

import { scrubSecrets } from '../sandbox/env.js';
import { killTree } from '../sandbox/runner.js';
import { toAbsolute } from '../workspace/resolve.js';

/**
 * The terminal's process runner (D301, design §6.3): one line a person typed, run through the
 * platform shell in a folder confined to the project, with stdin open for prompts and REPL lines,
 * output decoded as UTF-8 across chunk boundaries, and the whole tree killed on Stop. There is no
 * TTY (design §14): full-screen programs do not render, line prompts work.
 *
 * Like `run_command`, a run ends when the shell exits, not when its output closes: something the
 * command left running holds the pipes and would otherwise hold the run open forever.
 */

/** After the shell exits, how long its last output may take to arrive before the pipes are dropped. */
const EXIT_DRAIN_MS = 300;
/** After a stop, how long to wait for the shell to go before reporting the end anyway. */
const KILL_SETTLE_MS = 1_500;

export interface ProcessRunnerOptions {
  platform?: NodeJS.Platform;
  /** What a process inherits before scrubbing. Default: the engine's own, read at each start. */
  env?: Record<string, string | undefined>;
  /** The shell binary. Default: `ComSpec` (else `cmd.exe`) on Windows, `/bin/sh` elsewhere. */
  shell?: string;
}

const isNetworkPath = (path: string): boolean => path.startsWith('\\\\') || path.startsWith('//');

const networkFolderRefusal = (cwd: string): WorkspaceFsError =>
  new WorkspaceFsError(
    'invalid_path',
    "the terminal can't run in a network folder on Windows — map it to a drive letter",
    { path: cwd },
  );

/**
 * Where a process runs (FR-GIT-008, D301 decision 4): confined exactly as a file read is — `..`,
 * absolute and drive paths, links out and `.git` are refused — and an existing folder.
 */
export function resolveWorkingFolder(
  root: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // cmd.exe cannot use a UNC current directory: it prints "UNC paths are not supported" and runs
  // the line in C:\Windows, where a `del` or `git clean` would hit the wrong folder.
  if (platform === 'win32' && isNetworkPath(root)) throw networkFolderRefusal(cwd);
  const absolute = toAbsolute(root, cwd, { allowRoot: true });
  if (platform === 'win32' && isNetworkPath(absolute)) throw networkFolderRefusal(cwd);
  let isFolder = false;
  try {
    isFolder = statSync(absolute).isDirectory();
  } catch {
    isFolder = false;
  }
  if (!isFolder) {
    throw new WorkspaceFsError(
      'invalid_path',
      cwd === '' ? 'The project folder is missing.' : `${cwd} is not a folder in the project.`,
      { path: cwd },
    );
  }
  return absolute;
}

/** The platform shell and its arguments, exactly as `run_command` spawns them (D301 decision 2). */
export function shellCommand(
  command: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  shell?: string,
): [string, string[]] {
  // cmd.exe /s strips exactly the outer quotes we add, so the line runs as written.
  return platform === 'win32'
    ? [shell ?? env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`]]
    : [shell ?? '/bin/sh', ['-c', command]];
}

function spawnShell(
  shell: string,
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  platform: NodeJS.Platform,
) {
  return spawn(shell, argv, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: platform === 'win32',
    // POSIX: lead a process group so one kill reaches everything the command started.
    detached: platform !== 'win32',
  });
}

type ShellChild = ReturnType<typeof spawnShell>;

const NOT_STARTED: RunningProcess = {
  pid: undefined,
  write: () => undefined,
  stop: () => undefined,
};

export function createProcessRunner(options: ProcessRunnerOptions = {}): ProcessRunner {
  const platform = options.platform ?? process.platform;
  return {
    start(spec, handlers) {
      const cwd = resolveWorkingFolder(spec.root, spec.cwd, platform);
      const source = options.env ?? process.env;
      const env = scrubSecrets({ ...source, ...(spec.env ?? {}) }, platform);
      const [shell, argv] = shellCommand(spec.command, platform, source, options.shell);
      let child: ShellChild;
      try {
        child = spawnShell(shell, argv, cwd, env, platform);
      } catch (error) {
        // An argument Node refuses outright: still "never started", and still said asynchronously.
        const reason = error instanceof Error ? error : new Error(String(error));
        queueMicrotask(() => handlers.onError(reason));
        return NOT_STARTED;
      }
      return supervise(child, handlers, platform);
    },
  };
}

function supervise(
  child: ShellChild,
  handlers: ProcessHandlers,
  platform: NodeJS.Platform,
): RunningProcess {
  const decoders: Record<ProcessStream, StringDecoder> = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };
  const timers: NodeJS.Timeout[] = [];
  let settled = false;
  /** The person asked for a stop: the end reads SIGKILL on every platform (D301). */
  let stopped = false;
  /** The shell itself has ended: its pid may already belong to someone else. */
  let exited = false;

  const say = (stream: ProcessStream, text: string): void => {
    if (!settled && text !== '') handlers.onOutput(stream, text);
  };

  // taskkill /F leaves cmd.exe's exit code 1, and POSIX reports the signal; either way a stop is
  // a stop, not a failure. A process that ended by itself keeps its own code and signal.
  const ended = (code: number | null, signal: string | null): void =>
    stopped ? handlers.onExit(null, 'SIGKILL') : handlers.onExit(code, signal);

  const finish = (report: () => void): void => {
    if (settled) return;
    // A character the last chunk cut in half is said (as U+FFFD) rather than lost.
    say('stdout', decoders.stdout.end());
    say('stderr', decoders.stderr.end());
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    report();
  };

  child.stdout.on('data', (chunk: Buffer) => say('stdout', decoders.stdout.write(chunk)));
  child.stderr.on('data', (chunk: Buffer) => say('stderr', decoders.stderr.write(chunk)));
  // EPIPE once the process is gone: input to a finished process is dropped, never thrown.
  child.stdin.on('error', () => undefined);
  // A stream error is never uncaught (it would take the engine, and every process, down); the
  // exit still reports.
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  child.on('error', (error) => {
    // Only a spawn failure means "never started"; any later error is followed by exit or close.
    if (child.pid === undefined) finish(() => handlers.onError(error));
  });
  child.on('exit', (code, signal) => {
    exited = true;
    timers.push(setTimeout(() => finish(() => ended(code, signal)), EXIT_DRAIN_MS));
  });
  child.on('close', (code, signal) => finish(() => ended(code, signal)));

  return {
    pid: child.pid,
    write(data) {
      if (!settled && child.stdin.writable) child.stdin.write(data);
    },
    stop() {
      // Once the shell has ended, a kill could hit a reused pid and would relabel its real exit.
      if (settled || exited || stopped) return;
      stopped = true;
      if (child.pid !== undefined) killTree(child.pid, platform);
      // A shell that outlives its kill must not leave the run open.
      timers.push(setTimeout(() => finish(() => ended(null, 'SIGKILL')), KILL_SETTLE_MS));
    },
  };
}
