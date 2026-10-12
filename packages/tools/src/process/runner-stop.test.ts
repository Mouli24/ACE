import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type * as ChildProcessModule from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SandboxRunnerModule from '../sandbox/runner.js';

const probes = vi.hoisted(() => ({
  kills: [] as number[],
  children: [] as ChildProcess[],
}));

vi.mock('../sandbox/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxRunnerModule>();
  return {
    ...actual,
    killTree: (pid: number, platform: NodeJS.Platform) => {
      probes.kills.push(pid);
      actual.killTree(pid, platform);
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      probes.children.push(child);
      return child;
    },
  };
});

import { createProcessRunner } from './runner.js';

let root: string;
const node = (script: string) => `"${process.execPath}" -e "${script}"`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-stop-'));
  mkdirSync(join(root, 'p'));
  probes.kills.length = 0;
  probes.children.length = 0;
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    // The OS reclaims temp itself.
  }
});

function run(command: string) {
  const events: Array<[string, ...unknown[]]> = [];
  let out = '';
  let end: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const handle = createProcessRunner().start(
    { root: join(root, 'p'), cwd: '', command },
    {
      onOutput: (_stream, chunk) => {
        out += chunk;
      },
      onExit: (code, signal) => {
        events.push(['exit', code, signal]);
        end();
      },
      onError: (error) => {
        events.push(['error', error.message]);
        end();
      },
    },
  );
  return { events, handle, ended, text: () => out };
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe('D301 stop() after the shell has ended', () => {
  it('keeps the real exit code and kills nothing when stop() comes after the shell exited', async () => {
    // The shell exits at once, but a grandchild holds the pipes for 1 s, so `onExit` waits out
    // the 300 ms drain: stop() lands in that window.
    const r = run(
      node(
        "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }); console.log('bye'); process.exit(5)",
      ),
    );
    // The shell has exited (its own `exit` event fired) but `onExit` has not been said yet.
    expect(await until(() => (probes.children[0]?.exitCode ?? null) !== null, 10_000)).toBe(true);
    expect(r.events).toEqual([]);
    r.handle.stop();
    await r.ended;
    expect(r.events).toEqual([['exit', 5, null]]);
    expect(probes.kills).toEqual([]);
  }, 20_000);

  it('a double stop() kills once and reports once', async () => {
    const r = run(node("console.log('up'); setInterval(() => {}, 1000)"));
    expect(await until(() => r.text().includes('up'), 10_000)).toBe(true);
    r.handle.stop();
    r.handle.stop();
    await r.ended;
    expect(probes.kills).toHaveLength(1);
    expect(r.events).toEqual([['exit', null, 'SIGKILL']]);
  }, 20_000);
});

describe('D301 a stream error', () => {
  it('on stdout or stderr is never uncaught, and the process still reports its exit', async () => {
    const r = run(node("console.log('up'); setTimeout(() => process.exit(4), 300)"));
    expect(await until(() => r.text().includes('up'), 10_000)).toBe(true);
    const child = probes.children[0];
    expect(() => {
      child?.stdout?.emit('error', new Error('boom'));
      child?.stderr?.emit('error', new Error('boom'));
    }).not.toThrow();
    await r.ended;
    expect(r.events).toEqual([['exit', 4, null]]);
  }, 20_000);
});
