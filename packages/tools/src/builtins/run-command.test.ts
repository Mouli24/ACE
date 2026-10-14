import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import { createBackgroundProcesses } from '../agent/background.js';
import { agentEnv } from '../agent/env.js';
import { type AgentSession } from '../agent/session.js';
import { resolveAgentShell } from '../agent/shell.js';
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
  rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
});

const ctx = (extra: { signal?: AbortSignal; session?: AgentSession } = {}) => {
  const context = makeContext({ projectDir: project, nodeId: 'node-a', ...extra });
  cleanups.push(context.cleanup);
  return context;
};

const shell = resolveAgentShell({ platform: process.platform, env: process.env });

/** A `node -e` command line for the agent shell (bash, or PowerShell when Git is missing). */
const node = (script: string) => {
  const exe = process.execPath.replace(/\\/g, '/');
  return shell.kind === 'powershell'
    ? `& '${exe}' -e '${script.replace(/'/g, "''")}'`
    : `'${exe}' -e '${script.replace(/'/g, `'\\''`)}'`;
};
const run = createRunCommandTool();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const session = (): AgentSession => {
  const processes = createBackgroundProcesses({
    platform: process.platform,
    env: agentEnv(process.env, process.platform),
    shell,
  });
  cleanups.push(() => void processes.killAll());
  return {
    ledger: { record: () => undefined, seen: () => undefined },
    locks: { withLock: (_path, fn) => fn() },
    processes,
  };
};

describe('FR-TOOL-008 run_command (X1, D266, agentic nodes)', () => {
  it('is destructive, so every call asks for approval', () => {
    expect(RUN_COMMAND_DEFINITION.permissions.destructive).toBe(true);
    expect(RUN_COMMAND_DEFINITION.inputSchema).toMatchObject({
      properties: { command: {}, cwd: {}, timeoutMs: {}, background: {} },
    });
  });

  it('names the shell it really runs in, in the description the model sees', () => {
    expect(run.definition.description).toContain(shell.label);
  });

  it('runs in the project folder (a path with spaces) and returns the exit code and output', async () => {
    const result = (await run.implementation(
      { command: node('console.log(process.cwd())') },
      ctx(),
    )) as {
      exitCode: number;
      stdout: string;
      durationMs: number;
    };
    expect(result.exitCode).toBe(0);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(project));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs in a sub-folder, and refuses one outside the project', async () => {
    const result = (await run.implementation(
      { command: node('console.log(process.cwd())'), cwd: 'sub' },
      ctx(),
    )) as {
      stdout: string;
    };
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(join(project, 'sub')));
    await expect(run.implementation({ command: node('1'), cwd: '..' }, ctx())).rejects.toThrow(
      /inside the project folder/,
    );
  });

  it('returns a failing exit code rather than throwing, and keeps quotes and & intact', async () => {
    expect(await run.implementation({ command: node('process.exit(4)') }, ctx())).toMatchObject({
      exitCode: 4,
    });
    const result = (await run.implementation({ command: node("console.log('a & b')") }, ctx())) as {
      stdout: string;
    };
    expect(result.stdout.trim()).toBe('a & b');
  });

  it('caps a flood of output to its head and tail, marking the cut', async () => {
    const result = (await run.implementation(
      { command: node("process.stdout.write('H' + 'x'.repeat(200000) + 'T')") },
      ctx(),
    )) as { stdout: string; truncated: boolean };
    expect(result.stdout.startsWith('H')).toBe(true);
    expect(result.stdout.endsWith('T')).toBe(true);
    expect(result.stdout).toMatch(/\[… \d+ chars cut …\]/);
    expect(result.stdout.length).toBeLessThan(30_100);
    expect(result.truncated).toBe(true);
  });

  it('the command sees no API key or engine token, but does see PATH and CI=1', async () => {
    const planted = { ANTHROPIC_API_KEY: 'sk-ant-planted', ACE_SESSION_TOKEN: 'token-planted' };
    Object.assign(process.env, planted);
    try {
      const result = (await run.implementation(
        { command: node('console.log(JSON.stringify(process.env))') },
        ctx(),
      )) as { stdout: string };
      const env = JSON.parse(result.stdout.trim()) as Record<string, string>;
      expect(Object.values(env)).not.toContain('sk-ant-planted');
      expect(Object.values(env)).not.toContain('token-planted');
      expect(Object.keys(env).some((key) => key.toUpperCase() === 'PATH')).toBe(true);
      expect(env['CI']).toBe('1');
      expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['ACE_SESSION_TOKEN'];
    }
  });

  it('stdin is closed, so a prompt fails fast instead of hanging', async () => {
    const result = (await run.implementation(
      { command: node("process.stdin.on('data', () => {}).on('end', () => console.log('eof'))") },
      ctx(),
    )) as { stdout: string };
    expect(result.stdout.trim()).toBe('eof');
  });

  it('reports the files the command changed', async () => {
    const result = (await run.implementation(
      {
        command: node(
          "require('fs').mkdirSync('gen', { recursive: true }); require('fs').writeFileSync('gen/out.txt', 'x')",
        ),
      },
      ctx(),
    )) as { changedPaths: string[] };
    expect(result.changedPaths).toEqual(['gen/out.txt']);
  });

  it('times out and kills the command', async () => {
    await expect(
      run.implementation({ command: node('setInterval(() => {}, 1000)'), timeoutMs: 1_000 }, ctx()),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('a timeout kills a grandchild too', async () => {
    const pidFile = join(project, 'grandchild.pid').replace(/\\/g, '/');
    await expect(
      run.implementation(
        {
          command: node(
            `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync('${pidFile}', String(c.pid)); setInterval(() => {}, 1000)`,
          ),
          timeoutMs: 1_000,
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(grandchild).toBeGreaterThan(0);
    const end = Date.now() + 3_000;
    while (alive(grandchild) && Date.now() < end) await sleep(50);
    expect(alive(grandchild)).toBe(false);
  });

  it('returns once the shell exits, even if something it started still holds the output (review I5)', async () => {
    // A grandchild that inherits stdout and outlives the shell: 'close' would wait 4 s for it.
    const orphan = node(
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'inherit', detached: true, cwd: require('os').tmpdir(), windowsHide: true }).unref(); console.log('started')",
    );
    const started = Date.now();
    const result = (await run.implementation({ command: orphan }, ctx())) as {
      exitCode: number;
      stdout: string;
    };
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.stdout).toContain('started');
  });

  it('a Stop ends it within 2 s', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = run.implementation(
      { command: node('setInterval(() => {}, 1000)') },
      ctx({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toThrow(/stopped/);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('background: refused without an agent session', async () => {
    await expect(
      run.implementation({ command: node('1'), background: true }, ctx()),
    ).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('background: starts in the session and answers at once with a processId', async () => {
    const agent = session();
    const started = Date.now();
    const result = await run.implementation(
      { command: node("console.log('up'); setInterval(() => {}, 1000)"), background: true },
      ctx({ session: agent }),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({ processId: 'bg_1', background: true });
    const end = Date.now() + 5_000;
    let out = '';
    while (!out.includes('up') && Date.now() < end) {
      out += agent.processes.output('bg_1')?.stdout ?? '';
      await sleep(25);
    }
    expect(out).toContain('up');
    expect(await agent.processes.kill('bg_1')).toBe(true);
  });
});
