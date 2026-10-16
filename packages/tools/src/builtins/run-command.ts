import { spawn } from 'node:child_process';

import { type ToolDefinition } from '@ace/contracts';
import { z } from 'zod';

import { changedPaths, snapshotWorkspace, type WorkspaceSnapshot } from '../agent/changes.js';
import { agentEnv } from '../agent/env.js';
import { MODEL_OUTPUT_CHARS, OutputBuffer } from '../agent/output.js';
import { resolveAgentShell, shellInvocation, type AgentShell } from '../agent/shell.js';
import { ToolError } from '../errors.js';
import { assertInsideProject } from '../project/paths.js';
import { type RegisteredTool } from '../registry.js';
import { killTree } from '../sandbox/runner.js';

/**
 * `run_command` (X1, FR-TOOL-008, D266; reworked for agentic nodes, `agentic-nodes-prompt.md`
 * Command runner): one shell command in the project folder, in the agent shell — Git Bash on
 * Windows (PowerShell when Git is missing), bash elsewhere ({@link resolveAgentShell}).
 *
 * - **Env** is an allowlist (`agentEnv`), never the engine's: no provider key, no engine token.
 * - **stdin** is closed, so an interactive prompt fails fast instead of hanging.
 * - **Output** going back to the model is capped to its head and tail with the cut marked.
 * - **Changes**: the project is snapshotted before and after, and the files the command changed
 *   are returned as `changedPaths` (project-relative) for `files.changed { source: "command" }`.
 * - **Background** (`background: true`, agentic runs only): started in the run's session and
 *   answered at once with a `processId`, read with `command_output`, ended with `kill_command`.
 *
 * It is **destructive**, so under the default policy every call waits for an approval card. A
 * command is not confined: it runs as the user and can reach anything the user can (D-083). A Stop
 * or the timeout kills the whole process tree.
 *
 * It ends when the shell exits, not when its output closes (review I5): something the command left
 * running inherits the output pipe and would hold it open past the timeout and past a Stop.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
/** Retained per stream while the command runs; what the model gets is capped further. */
const RETAIN_CHARS = 1_000_000;
/** After the shell exits, how long its last output may take to arrive before the pipes are dropped. */
const EXIT_DRAIN_MS = 300;
/** After a kill, how long to wait for the shell to go before answering anyway. */
const KILL_SETTLE_MS = 1_500;

const RunArgs = z.strictObject({
  command: z.string().min(1).max(8_000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  background: z.boolean().optional(),
});

function definitionFor(shellText: string): ToolDefinition {
  return {
    name: 'run_command',
    description: `Runs a shell command in the project folder with ${shellText} and returns its exit code, output (head and tail, capped) and the files it changed. stdin is closed: nothing can prompt. background: true starts it and returns a processId at once (read it with command_output, stop it with kill_command). Destructive: every call asks for approval.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line, e.g. "pnpm test".' },
        cwd: {
          type: 'string',
          description: 'Folder relative to the project; the project root when omitted.',
        },
        timeoutMs: { type: 'integer', minimum: 1_000, maximum: 600_000 },
        background: {
          type: 'boolean',
          description: 'Start it and return a processId at once (dev servers, watchers).',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    permissions: { network: true, fsPaths: ['<project>'], destructive: true },
    timeoutMs: 600_000,
    source: 'builtin',
  };
}

/** The definition as listed without a resolved shell (`GET /tools`, the contract tests). */
export const RUN_COMMAND_DEFINITION: ToolDefinition = definitionFor(
  'Git Bash on Windows (Windows PowerShell when Git is not installed) and bash elsewhere',
);

export interface RunCommandOptions {
  platform?: NodeJS.Platform;
  /** The command's exact env. Defaults to `agentEnv(process.env)`, read at each call. */
  env?: Record<string, string>;
  /** The shell. Defaults to {@link resolveAgentShell} over `process.env`. */
  shell?: AgentShell;
}

async function snapshot(
  root: string | undefined,
  previous?: WorkspaceSnapshot,
): Promise<WorkspaceSnapshot | undefined> {
  if (root === undefined) return undefined;
  try {
    return await snapshotWorkspace(root, previous === undefined ? {} : { previous });
  } catch {
    // Change detection is a report, never a reason for the command itself to fail.
    return undefined;
  }
}

export function createRunCommandTool(options: RunCommandOptions = {}): RegisteredTool {
  const platform = options.platform ?? process.platform;
  const shell = options.shell ?? resolveAgentShell({ platform, env: process.env });

  return {
    definition: definitionFor(shell.label),
    implementation: async (args, context) => {
      const parsed = RunArgs.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ToolError(
          'invalid_args',
          'run_command',
          'run_command needs { command, cwd?, timeoutMs?, background? }.',
          { issues: parsed.error.issues.map((issue) => issue.message) },
        );
      }
      const cwd = assertInsideProject({
        projectDir: context.projectDir,
        candidate: parsed.data.cwd,
        toolName: 'run_command',
        operation: 'run in',
        logger: context.logger,
        runId: context.runId,
      });

      if (parsed.data.background === true) {
        if (context.session === undefined) {
          throw new ToolError(
            'unavailable',
            'run_command',
            'background: true needs an agentic node run; run it in the foreground instead.',
          );
        }
        const { processId } = context.session.processes.start({
          nodeId: context.nodeId ?? 'unknown',
          command: parsed.data.command,
          cwd,
        });
        return { processId, background: true };
      }

      const env = options.env ?? agentEnv(process.env, platform);
      const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const spec = shellInvocation(shell, parsed.data.command, env);
      const before = await snapshot(context.projectDir);
      const startedAt = Date.now();
      // PG-5.3: an agentic run's command shows, read-only, in Forge's Terminal and Processes list
      const watch =
        context.session?.commands === undefined || context.nodeId === undefined
          ? undefined
          : context.session.commands.started({
              nodeId: context.nodeId,
              command: parsed.data.command,
              cwd,
              background: false,
            });

      const outcome = await new Promise<{
        code: number | null;
        timedOut: boolean;
        stopped: boolean;
        error?: Error;
        stdout: OutputBuffer;
        stderr: OutputBuffer;
      }>((resolve) => {
        const stdout = new OutputBuffer(RETAIN_CHARS);
        const stderr = new OutputBuffer(RETAIN_CHARS);
        let timedOut = false;
        let settled = false;

        const child = spawn(spec.file, spec.args, {
          cwd,
          env: spec.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // POSIX: lead a process group so one kill reaches everything the command started.
          detached: platform !== 'win32',
        });
        const timers: NodeJS.Timeout[] = [];
        const later = (ms: number, fn: () => void): void => {
          timers.push(setTimeout(fn, ms));
        };
        const stop = (): void => {
          if (child.pid !== undefined) killTree(child.pid, platform);
          // A shell that outlives its kill must not hang the call.
          later(KILL_SETTLE_MS, () => done(null));
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        const onAbort = (): void => stop();
        context.signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (code: number | null, error?: Error): void => {
          if (settled) return;
          settled = true;
          if (error !== undefined) {
            watch?.output('stderr', `Could not start the shell: ${error.message}\n`);
          }
          watch?.exited(code, error !== undefined);
          clearTimeout(timer);
          for (const pending of timers) clearTimeout(pending);
          child.stdout.destroy();
          child.stderr.destroy();
          context.signal?.removeEventListener('abort', onAbort);
          resolve({
            code,
            timedOut,
            stopped: context.signal?.aborted === true,
            stdout,
            stderr,
            ...(error === undefined ? {} : { error }),
          });
        };
        const done = (code: number | null): void => finish(code);

        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout.push(chunk);
          watch?.output('stdout', chunk);
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr.push(chunk);
          watch?.output('stderr', chunk);
        });
        child.stdout.on('error', () => undefined);
        child.stderr.on('error', () => undefined);
        child.on('error', (error) => finish(null, error));
        child.on('exit', (code) => later(EXIT_DRAIN_MS, () => done(code)));
        child.on('close', (code) => done(code));
      });

      const durationMs = Date.now() - startedAt;
      if (outcome.error !== undefined) {
        throw new ToolError(
          'failed',
          'run_command',
          `Could not start the shell: ${outcome.error.message}`,
        );
      }
      if (outcome.stopped && !outcome.timedOut) {
        throw new ToolError('failed', 'run_command', 'The command was stopped.');
      }
      const after = before === undefined ? undefined : await snapshot(context.projectDir, before);
      const changed =
        before === undefined || after === undefined ? [] : changedPaths(before, after);
      const stdout = outcome.stdout.text(MODEL_OUTPUT_CHARS);
      const stderr = outcome.stderr.text(MODEL_OUTPUT_CHARS);
      if (outcome.timedOut) {
        throw new ToolError(
          'timeout',
          'run_command',
          `The command did not finish within ${timeoutMs} ms.`,
          {
            stdoutTail: outcome.stdout.text(4_000),
            stderrTail: outcome.stderr.text(4_000),
            durationMs,
            changedPaths: changed,
          },
        );
      }
      return {
        exitCode: outcome.code,
        stdout,
        stderr,
        truncated:
          outcome.stdout.length > MODEL_OUTPUT_CHARS || outcome.stderr.length > MODEL_OUTPUT_CHARS,
        durationMs,
        changedPaths: changed,
      };
    },
  };
}
