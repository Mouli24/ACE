import type { ChildProcess } from 'node:child_process';

import type { CommandResult, CommandRunner } from '@ace/engine';

import { isDirectory } from './is-directory.js';
import { killProcessTree } from './kill-tree.js';
import { mergeEnv } from './merge-env.js';
import { appendOutput, outputTail, spawnShell } from './shell.js';

/**
 * How long a killed command may take to close its pipes before the result is settled anyway — a
 * descendant that escaped the tree kill must not wedge the task behind it.
 */
const KILL_GRACE_MS = 3_000;

/**
 * The command runner for a project's check and setup commands (D271, ACE parity P0 §5).
 *
 * The command line is the user's own, run through the platform shell exactly as they would type it:
 * `cmd.exe /d /s /c "<command>"` on Windows (the same quoting Node's `shell: true` uses, so a
 * quoted program path survives `/s`), `/bin/sh -c <command>` elsewhere. It is not sandboxed — it
 * has the same trust as a local CI script — but it is bounded: the timeout and the abort signal
 * kill the whole process tree, and only the last `maxOutput` characters of output are kept.
 *
 * It never rejects: a non-zero exit is a result, and a command that could not start at all (a
 * missing folder, no shell) resolves with `exitCode: null` and the reason in `output`.
 */
export function createCommandRunner(): CommandRunner {
  return {
    run: (input) => runCommand(input),
  };
}

type RunInput = Parameters<CommandRunner['run']>[0];

async function runCommand(input: RunInput): Promise<CommandResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);

  if (!(await isDirectory(input.cwd))) {
    return {
      exitCode: null,
      output: `Cannot run the command: the folder ${input.cwd} does not exist.`,
      timedOut: false,
      durationMs: elapsed(),
    };
  }
  if (input.signal?.aborted === true) {
    return {
      exitCode: null,
      output: 'Cancelled before it started.',
      timedOut: false,
      durationMs: elapsed(),
    };
  }

  const platform = process.platform;
  const env = mergeEnv(process.env, input.env);

  return new Promise<CommandResult>((resolve) => {
    let output = '';
    let timedOut = false;
    let killed = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const append = (chunk: string): void => {
      output = appendOutput(output, chunk, input.maxOutput);
    };

    let child: ChildProcess;
    try {
      child = spawnShell(input.command, { cwd: input.cwd, env, platform });
    } catch (error) {
      resolve({
        exitCode: null,
        output: `Cannot run the command: ${messageOf(error)}`,
        timedOut: false,
        durationMs: elapsed(),
      });
      return;
    }

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      input.signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        exitCode: killed ? null : exitCode,
        output: outputTail(output, input.maxOutput),
        timedOut,
        durationMs: elapsed(),
      });
    };

    const kill = (): void => {
      if (killed) return;
      killed = true;
      if (child.pid !== undefined) killProcessTree(child.pid, platform);
      graceTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
    };

    const onAbort = (): void => kill();

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (error) => {
      append(`${output === '' ? '' : '\n'}Cannot run the command: ${error.message}`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
