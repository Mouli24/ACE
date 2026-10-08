import { spawn } from 'node:child_process';

import { type ToolDefinition } from '@ace/contracts';
import { z } from 'zod';

import { ToolError } from '../errors.js';
import { assertInsideProject } from '../project/paths.js';
import { type RegisteredTool } from '../registry.js';
import { killTree } from '../sandbox/runner.js';

/**
 * `run_command` (X1, FR-TOOL-008, D266): one shell command in the project folder — `cmd.exe` on
 * Windows, `/bin/sh` elsewhere — returning its exit code and the tail of its output. It is
 * **destructive**, so under the default policy every call waits for an approval card: on Windows it
 * runs with no sandbox at all (the D-083 risk). A Stop or the timeout kills the whole process tree.
 */

const OUTPUT_TAIL_CHARS = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

const RunArgs = z.strictObject({
  command: z.string().min(1).max(8_000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
});

export const RUN_COMMAND_DEFINITION: ToolDefinition = {
  name: 'run_command',
  description:
    'Runs a shell command in the project folder (cmd.exe on Windows, /bin/sh elsewhere) and returns its exit code and output. Destructive: every call asks for approval.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line, e.g. "pnpm test".' },
      cwd: { type: 'string', description: 'Folder relative to the project; the project root when omitted.' },
      timeoutMs: { type: 'integer', minimum: 1_000, maximum: 600_000 },
    },
    required: ['command'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  permissions: { network: true, fsPaths: ['<project>'], destructive: true },
  timeoutMs: 600_000,
  source: 'builtin',
};

export interface RunCommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export function createRunCommandTool(options: RunCommandOptions = {}): RegisteredTool {
  return {
    definition: RUN_COMMAND_DEFINITION,
    implementation: async (args, context) => {
      const parsed = RunArgs.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ToolError('invalid_args', 'run_command', 'run_command needs { command, cwd?, timeoutMs? }.', {
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }
      const cwd = assertInsideProject({
        projectDir: context.projectDir,
        candidate: parsed.data.cwd,
        toolName: 'run_command',
        operation: 'run in',
        logger: context.logger,
        runId: context.runId,
      });
      const platform = options.platform ?? process.platform;
      const env = options.env ?? process.env;
      const timeoutMs = parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      // cmd.exe /s strips exactly the outer quotes we add, so the line runs as written.
      const [shell, argv] =
        platform === 'win32'
          ? [env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${parsed.data.command}"`]]
          : ['/bin/sh', ['-c', parsed.data.command]];

      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const keep = (current: string, chunk: string): string => {
          const next = current + chunk;
          if (next.length <= OUTPUT_TAIL_CHARS) return next;
          truncated = true;
          return next.slice(-OUTPUT_TAIL_CHARS);
        };

        const child = spawn(shell, argv, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: platform === 'win32',
          // POSIX: lead a process group so one kill reaches everything the command started.
          detached: platform !== 'win32',
        });
        const stop = (): void => {
          if (child.pid !== undefined) killTree(child.pid, platform);
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        const onAbort = (): void => stop();
        context.signal?.addEventListener('abort', onAbort, { once: true });

        const finish = (settle: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          context.signal?.removeEventListener('abort', onAbort);
          settle();
        };

        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout = keep(stdout, chunk);
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr = keep(stderr, chunk);
        });
        child.on('error', (error) =>
          finish(() => reject(new ToolError('failed', 'run_command', `Could not start the shell: ${error.message}`))),
        );
        child.on('close', (code) =>
          finish(() => {
            if (timedOut) {
              reject(
                new ToolError('timeout', 'run_command', `The command did not finish within ${timeoutMs} ms.`, {
                  stdoutTail: stdout.slice(-2_000),
                  stderrTail: stderr.slice(-2_000),
                }),
              );
            } else if (context.signal?.aborted === true) {
              reject(new ToolError('failed', 'run_command', 'The command was stopped.'));
            } else {
              resolve({ exitCode: code, stdout, stderr, truncated });
            }
          }),
        );
      });
    },
  };
}
