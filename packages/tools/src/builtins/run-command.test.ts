import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import { RUN_COMMAND_DEFINITION, createRunCommandTool } from './run-command.js';

let root: string;
let project: string;
let cleanups: (() => void)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-run-'));
  project = join(root, 'demo project');
  mkdirSync(join(project, 'sub'), { recursive: true });
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const ctx = (signal?: AbortSignal) => {
  const context = makeContext({ projectDir: project, ...(signal === undefined ? {} : { signal }) });
  cleanups.push(context.cleanup);
  return context;
};

/** A `node -e` command line that survives both cmd.exe and /bin/sh. */
const node = (script: string) => `"${process.execPath}" -e "${script}"`;
const run = createRunCommandTool();

describe('FR-TOOL-008 run_command (X1, D266)', () => {
  it('is destructive, so every call asks for approval', () => {
    expect(RUN_COMMAND_DEFINITION.permissions.destructive).toBe(true);
  });

  it('runs in the project folder (a path with spaces) and returns the exit code and output', async () => {
    const result = (await run.implementation({ command: node('console.log(process.cwd())') }, ctx())) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(project));
  });

  it('runs in a sub-folder, and refuses one outside the project', async () => {
    const result = (await run.implementation({ command: node('console.log(process.cwd())'), cwd: 'sub' }, ctx())) as { stdout: string };
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(join(project, 'sub')));
    await expect(run.implementation({ command: node('1'), cwd: '..' }, ctx())).rejects.toThrow(/inside the project folder/);
  });

  it('returns a failing exit code rather than throwing, and keeps quotes and & intact', async () => {
    expect(await run.implementation({ command: node('process.exit(4)') }, ctx())).toMatchObject({ exitCode: 4 });
    const result = (await run.implementation({ command: node("console.log('a & b')") }, ctx())) as { stdout: string };
    expect(result.stdout.trim()).toBe('a & b');
  });

  it('keeps only the tail of a flood of output', async () => {
    const result = (await run.implementation({ command: node("process.stdout.write('x'.repeat(200000))") }, ctx())) as {
      stdout: string;
      truncated: boolean;
    };
    expect(result.stdout.length).toBe(64 * 1024);
    expect(result.truncated).toBe(true);
  });

  it('times out and kills the command', async () => {
    await expect(
      run.implementation({ command: node('setInterval(() => {}, 1000)'), timeoutMs: 1_000 }, ctx()),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('returns once the shell exits, even if something it started still holds the output (review I5)', async () => {
    // A grandchild that inherits stdout and outlives the shell: 'close' would wait 4 s for it.
    const orphan = node(
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit', detached: true, cwd: require('os').tmpdir(), windowsHide: true }).unref(); console.log('started')",
    );
    const started = Date.now();
    const result = (await run.implementation({ command: orphan }, ctx())) as { exitCode: number; stdout: string };
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain('started');
  });

  it('a Stop ends it within 2 s', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = run.implementation({ command: node('setInterval(() => {}, 1000)') }, ctx(controller.signal));
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow(/stopped/);
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});
