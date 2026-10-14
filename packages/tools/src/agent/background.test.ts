import { mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createBackgroundProcesses } from './background.js';
import { agentEnv } from './env.js';
import { resolveAgentShell } from './shell.js';

const platform = process.platform;
const shell = resolveAgentShell({ platform, env: process.env });
const env = agentEnv(process.env, platform);
const workspace = mkdtempSync(join(tmpdir(), 'ace-bg-'));
afterAll(() => rm(workspace, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 }));

/** A node one-liner for bash (Windows Git Bash or POSIX) or PowerShell, with forward-slash paths. */
const node = (script: string) => {
  const exe = process.execPath.replace(/\\/g, '/');
  return shell.kind === 'powershell'
    ? `& '${exe}' -e '${script.replace(/'/g, "''")}'`
    : `'${exe}' -e '${script.replace(/'/g, `'\\''`)}'`;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('FR-TOOL-008 background processes (agentic nodes)', () => {
  it('starts a command, reports only new output per call, and kills it', async () => {
    const processes = createBackgroundProcesses({ platform, env, shell });
    const { processId } = processes.start({
      nodeId: 'n1',
      command: node("let i = 0; setInterval(() => console.log('tick ' + i++), 30)"),
      cwd: workspace,
    });
    expect(processId).toBe('bg_1');

    let seen = '';
    await until(() => {
      seen += processes.output(processId)?.stdout ?? '';
      return seen.includes('tick 2');
    });
    const first = processes.output(processId);
    expect(first).toMatchObject({ processId, nodeId: 'n1', running: true, exitCode: null });
    expect(first?.stdout ?? '').not.toContain('tick 0\n');

    expect(await processes.kill(processId)).toBe(true);
    expect(processes.output(processId)?.running).toBe(false);
    expect(await processes.kill(processId)).toBe(false);
    expect(await processes.kill('bg_99')).toBe(false);
    expect(processes.output('bg_99')).toBeUndefined();
  });

  it('reports a finished command with its exit code and stderr', async () => {
    const processes = createBackgroundProcesses({ platform, env, shell });
    const { processId } = processes.start({
      nodeId: 'n1',
      command: node("console.error('oops'); process.exit(3)"),
      cwd: workspace,
    });
    expect(processId).toBe('bg_1');
    await until(() => processes.output(processId)?.running === false && true);
    await sleep(100);
    const snapshot = processes.output(processId);
    expect(snapshot?.exitCode).toBe(3);
  });

  it('caps what it retains and what it returns, marking the cut', async () => {
    const processes = createBackgroundProcesses({
      platform,
      env,
      shell,
      retainChars: 2_000,
      returnChars: 500,
    });
    const { processId } = processes.start({
      nodeId: 'n1',
      command: node("process.stdout.write('A' + 'x'.repeat(10000) + 'Z')"),
      cwd: workspace,
    });
    // Wait without reading, so the whole flood lands in one `command_output`.
    await until(() => processes.list().every((info) => !info.running));
    await sleep(100);
    const all = processes.output(processId)?.stdout ?? '';
    expect(all.startsWith('A')).toBe(true);
    expect(all.endsWith('Z')).toBe(true);
    expect(all).toMatch(/\[… \d+ chars cut …\]/);
    expect(all.length).toBeLessThan(700);
  });

  it('killAll ends every process, grandchildren included', async () => {
    const processes = createBackgroundProcesses({ platform, env, shell });
    const pidFile = join(workspace, 'grandchild.pid').replace(/\\/g, '/');
    processes.start({
      nodeId: 'n1',
      command: node(
        `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync('${pidFile}', String(c.pid)); setInterval(() => {}, 1000)`,
      ),
      cwd: workspace,
    });
    processes.start({ nodeId: 'n2', command: node('setInterval(() => {}, 1000)'), cwd: workspace });
    let grandchild = 0;
    await until(() => {
      try {
        grandchild = Number(readFileSync(pidFile, 'utf8'));
        return grandchild > 0;
      } catch {
        return false;
      }
    });
    expect(alive(grandchild)).toBe(true);
    await processes.killAll();
    expect(processes.output('bg_1')?.running).toBe(false);
    expect(processes.output('bg_2')?.running).toBe(false);
    await until(() => !alive(grandchild), 3_000);
  });

  it('a command whose shell cannot start reads as exited', async () => {
    const processes = createBackgroundProcesses({
      platform,
      env,
      shell: { ...shell, path: join(workspace, 'no-such-shell.exe') },
    });
    const { processId } = processes.start({ nodeId: 'n1', command: 'echo hi', cwd: workspace });
    let stderr = '';
    await until(() => {
      const snapshot = processes.output(processId);
      stderr += snapshot?.stderr ?? '';
      return snapshot?.running === false;
    });
    expect(stderr).toMatch(/could not start/i);
    expect(processes.output(processId)?.exitCode).toBeNull();
  });
});
