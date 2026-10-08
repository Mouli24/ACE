import { spawn } from 'node:child_process';

import { type ToolDefinition } from '@ace/contracts';
import { z } from 'zod';

import { ToolError } from '../errors.js';
import { assertInsideProject, projectRelative } from '../project/paths.js';
import { type RegisteredTool } from '../registry.js';
import { type ToolContext } from '../tool.js';

/**
 * `git_status` and `git_diff` (X1, FR-TOOL-008): read-only views of the project's repository. git
 * runs with an argument array (no shell), never prompts, never pages, and takes no optional locks.
 */

const OUTPUT_LIMIT_CHARS = 256 * 1024;
const GIT_TIMEOUT_MS = 15_000;

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function runGit(args: string[], cwd: string, tool: string, signal: AbortSignal | undefined): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length >= OUTPUT_LIMIT_CHARS) {
        truncated = true;
        return;
      }
      stdout += chunk;
      if (stdout.length > OUTPUT_LIMIT_CHARS) {
        stdout = stdout.slice(0, OUTPUT_LIMIT_CHARS);
        truncated = true;
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new ToolError('unavailable', tool, `${tool}: git is not installed or not on PATH.`)
          : new ToolError('failed', tool, `${tool}: ${error.message}`),
      ),
    );
    child.on('close', (code) => resolve({ code, stdout, stderr, truncated }));
  });
}

function failed(tool: string, result: GitResult): ToolError {
  if (/not a git repository/i.test(result.stderr)) {
    return new ToolError('invalid_args', tool, `${tool}: the project folder is not a git repository.`);
  }
  return new ToolError('failed', tool, `${tool}: git exited ${result.code ?? 'by signal'}: ${result.stderr.trim().slice(-500)}`);
}

const projectRoot = (context: ToolContext, tool: string) =>
  assertInsideProject({
    projectDir: context.projectDir,
    candidate: undefined,
    toolName: tool,
    operation: 'read',
    logger: context.logger,
    runId: context.runId,
  });

const readOnly = (name: string, description: string, properties: Record<string, unknown>): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required: [], additionalProperties: false },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: ['<project>'], destructive: false },
  timeoutMs: GIT_TIMEOUT_MS,
  source: 'builtin',
});

export const GIT_STATUS_DEFINITION = readOnly(
  'git_status',
  'Shows the project repository’s branch and changed files (git status --porcelain).',
  {},
);

export function createGitStatusTool(): RegisteredTool {
  return {
    definition: GIT_STATUS_DEFINITION,
    implementation: async (_args, context) => {
      const cwd = projectRoot(context, 'git_status');
      const result = await runGit(['status', '--porcelain=v1', '-b'], cwd, 'git_status', context.signal);
      if (result.code !== 0) throw failed('git_status', result);
      const [head = '', ...entries] = result.stdout.split(/\r?\n/).filter((line) => line !== '');
      const branch = head.replace(/^## /, '').split('...')[0] ?? '';
      return { branch, entries, clean: entries.length === 0 };
    },
  };
}

const DiffArgs = z.strictObject({ staged: z.boolean().optional(), path: z.string().optional() });

export const GIT_DIFF_DEFINITION = readOnly(
  'git_diff',
  'Shows the project’s uncommitted changes as a unified diff; staged: true for what is staged.',
  {
    staged: { type: 'boolean' },
    path: { type: 'string', description: 'Limit to one path, relative to the project folder.' },
  },
);

export function createGitDiffTool(): RegisteredTool {
  return {
    definition: GIT_DIFF_DEFINITION,
    implementation: async (args, context) => {
      const parsed = DiffArgs.safeParse(args ?? {});
      if (!parsed.success) throw new ToolError('invalid_args', 'git_diff', 'git_diff needs { staged?, path? }.');
      const cwd = projectRoot(context, 'git_diff');
      const path =
        parsed.data.path === undefined
          ? undefined
          : projectRelative(
              cwd,
              assertInsideProject({
                projectDir: context.projectDir,
                candidate: parsed.data.path,
                toolName: 'git_diff',
                operation: 'read',
                logger: context.logger,
                runId: context.runId,
              }),
            );
      const result = await runGit(
        ['diff', '--no-color', ...(parsed.data.staged === true ? ['--cached'] : []), ...(path === undefined ? [] : ['--', path])],
        cwd,
        'git_diff',
        context.signal,
      );
      if (result.code !== 0) throw failed('git_diff', result);
      return { diff: result.stdout, truncated: result.truncated };
    },
  };
}
