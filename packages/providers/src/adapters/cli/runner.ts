import { spawn, type ChildProcess } from 'node:child_process';

import { createLineSplitter } from './lines.js';

/**
 * Runs one CLI call (X1 §5): the prompt goes on stdin (no quoting, no 32 K command-line limit —
 * review focus 3), stdout comes back a line at a time, and an abort kills the whole process tree,
 * because these CLIs start children of their own (review focus 2). Never a shell.
 */

export const STDERR_TAIL_CHARS = 8 * 1024;
/** How long an aborted call waits for the process to close before giving up on it. */
const KILL_SETTLE_MS = 1_500;

export interface CliRunOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  signal: AbortSignal;
  platform?: NodeJS.Platform;
}

export interface CliExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The last {@link STDERR_TAIL_CHARS} characters of stderr, for an error message. */
  stderrTail: string;
  /** Set when the process never started — ENOENT for a missing binary or working folder. */
  spawnError?: NodeJS.ErrnoException;
  /** The call was aborted and the tree killed. */
  killed: boolean;
}

export interface CliRun {
  lines: AsyncIterable<string>;
  exit: Promise<CliExit>;
}

/**
 * The code sandbox's rule (`packages/tools/src/sandbox/runner.ts`), repeated here because providers
 * may not import tools (CLAUDE.md §3.4 rule 3): `taskkill /T` on Windows, the process group elsewhere.
 */
export function killTree(pid: number, platform: NodeJS.Platform): void {
  try {
    if (platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => undefined);
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

/** A minimal async queue: pushes until closed, then drains and ends. */
function createChannel<T>(): AsyncIterable<T> & { push(item: T): void; close(): void } {
  const items: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    push(item) {
      if (closed) return;
      items.push(item);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
  };
}

export function runCli(options: CliRunOptions): CliRun {
  const platform = options.platform ?? process.platform;
  const output = createChannel<string>();
  const splitter = createLineSplitter();
  let stderrTail = '';
  let killed = false;
  let child: ChildProcess | undefined;
  let settle: (result: Omit<CliExit, 'stderrTail' | 'killed'>) => void = () => undefined;

  const onAbort = (): void => {
    killed = true;
    if (child?.pid !== undefined) killTree(child.pid, platform);
    // A process that ignores the kill must not hang the call.
    setTimeout(() => settle({ code: null, signal: 'SIGKILL' }), KILL_SETTLE_MS).unref();
  };

  const exit = new Promise<CliExit>((resolve) => {
    let settled = false;
    settle = (result) => {
      if (settled) return;
      settled = true;
      for (const line of splitter.end()) output.push(line);
      output.close();
      options.signal.removeEventListener('abort', onAbort);
      resolve({ ...result, stderrTail, killed });
    };
  });

  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX: lead a process group, so one kill reaches everything the CLI started.
      detached: platform !== 'win32',
    });
  } catch (error) {
    settle({ code: null, signal: null, spawnError: error as NodeJS.ErrnoException });
    return { lines: output, exit };
  }

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    for (const line of splitter.push(chunk)) output.push(line);
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  child.on('error', (error: NodeJS.ErrnoException) =>
    settle({ code: null, signal: null, spawnError: error }),
  );
  child.on('close', (code, signal) => settle({ code, signal }));

  // A CLI that exits before reading everything closes the pipe; that is its answer, not a crash.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(options.stdin, 'utf8');

  if (options.signal.aborted) onAbort();
  else options.signal.addEventListener('abort', onAbort, { once: true });

  return { lines: output, exit };
}
