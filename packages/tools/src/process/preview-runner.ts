import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { createServer } from 'node:net';

import type { PreviewProcess, PreviewRunner } from '@ace/engine';

import { killProcessTree } from './kill-tree.js';
import { mergeEnv } from './merge-env.js';
import { appendOutput, outputTail, spawnShell } from './shell.js';

/**
 * How long an exited or killed preview may take to close its pipes before it is counted as exited
 * anyway — a descendant that escaped the tree kill, or one the shell left behind, must not keep a
 * preview "running" forever.
 */
const CLOSE_GRACE_MS = 3_000;

/**
 * The preview runner (D278): a task's dev server, started from the project's `previewCommand` in
 * the task worktree and left running until the user stops it.
 *
 * The command line is the user's own (D271's trust), run through the platform shell exactly as the
 * command runner runs a check — `cmd.exe /d /s /c "<command>"` on Windows, `/bin/sh -c` elsewhere
 * — with the engine's environment and the caller's variables (`PORT`, the secrets in scope) on top.
 * Only the last `maxOutput` characters of output are kept. `stop` kills the whole process tree.
 *
 * `start` never throws: a command that cannot start (a missing folder, no shell) is a process that
 * has already exited, with `exitCode` `null` and the reason in its output.
 */
export function createPreviewRunner(): PreviewRunner {
  return {
    start: (input) => startPreview(input),
    freePort,
  };
}

type StartInput = Parameters<PreviewRunner['start']>[0];

function startPreview(input: StartInput): PreviewProcess {
  const platform = process.platform;
  let output = '';
  let exited = false;
  let killed = false;
  let code: number | null | undefined;
  let child: ChildProcess | undefined;
  let graceTimer: NodeJS.Timeout | undefined;
  const listeners: ((exitCode: number | null) => void)[] = [];
  let resolveExited!: () => void;
  const whenExited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });

  const append = (chunk: string): void => {
    output = appendOutput(output, chunk, input.maxOutput);
  };

  const notify = (listener: (exitCode: number | null) => void): void => {
    try {
      listener(code ?? null);
    } catch {
      // A listener's failure is its own; it must not stop the others hearing of the exit.
    }
  };

  const finish = (exitCode: number | null): void => {
    if (exited) return;
    exited = true;
    code = killed ? null : exitCode;
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    resolveExited();
    for (const listener of listeners.splice(0)) notify(listener);
  };

  /** Counts the process as exited after the grace period, unless its pipes close first. */
  const finishSoon = (exitCode: number | null): void => {
    if (exited || graceTimer !== undefined) return;
    graceTimer = setTimeout(() => finish(exitCode), CLOSE_GRACE_MS);
    graceTimer.unref();
  };

  const notStarted = (reason: string): void => {
    append(`Cannot start the preview: ${reason}`);
    // Asynchronously, so a caller sees the same order of events whether or not the start worked.
    queueMicrotask(() => finish(null));
  };

  if (!isDirectory(input.cwd)) {
    notStarted(`the folder ${input.cwd} does not exist.`);
  } else {
    try {
      child = spawnShell(input.command, {
        cwd: input.cwd,
        env: mergeEnv(process.env, input.env),
        platform,
      });
    } catch (error) {
      notStarted(messageOf(error));
    }
  }

  if (child !== undefined) {
    const started = child;
    started.stdout?.setEncoding('utf8');
    started.stderr?.setEncoding('utf8');
    started.stdout?.on('data', append);
    started.stderr?.on('data', append);
    started.on('error', (error) => {
      append(`${output === '' ? '' : '\n'}Cannot start the preview: ${error.message}`);
      finish(null);
    });
    // `exit` comes when the shell ends; `close` once its pipes are closed too, so the last output
    // is in. A pipe held open by something the shell left behind must not delay it for ever.
    started.on('exit', (exitCode) => finishSoon(exitCode));
    started.on('close', (exitCode) => finish(exitCode));
  }

  return {
    output: () => outputTail(output, input.maxOutput),
    running: () => !exited,
    exitCode: () => (exited ? (code ?? null) : undefined),

    stop: async () => {
      if (exited) return;
      if (!killed) {
        killed = true;
        if (child?.pid !== undefined) killProcessTree(child.pid, platform);
        finishSoon(null);
      }
      await whenExited;
    },

    onExit: (listener) => {
      if (exited) queueMicrotask(() => notify(listener));
      else listeners.push(listener);
    },
  };
}

/**
 * A TCP port free on 127.0.0.1 right now: the one the OS hands a listener on port 0. Another
 * process could take it before the preview binds it; the window is the few milliseconds until the
 * dev server starts listening.
 */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) reject(new Error('The OS did not report the port it chose.'));
        else resolve(port);
      });
    });
  });
}

/** Whether `path` is a folder, synchronously: `start` answers at once, with a process. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
