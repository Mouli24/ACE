import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PreviewProcess } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPreviewRunner } from './preview-runner.js';

/*
 * D278: a task's preview runs the project's preview command in the worktree through the platform
 * shell, with PORT set to a free local port, until it is stopped. Every command here is `node -e`,
 * so the suite runs the same on Windows (cmd.exe) and Linux (/bin/sh).
 */

const runner = createPreviewRunner();
const NODE = `"${process.execPath}"`;
let cwd: string;
let started: PreviewProcess[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ace-preview-'));
  started = [];
});

afterEach(async () => {
  await Promise.all(started.map((preview) => preview.stop()));
  rmSync(cwd, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 });
});

/** A `node -e` command line; `code` must not contain a double quote or a `$`. */
function node(code: string): string {
  return `${NODE} -e "${code}"`;
}

function start(command: string, extra: { env?: Record<string, string>; maxOutput?: number } = {}) {
  const preview = runner.start({
    command,
    cwd,
    maxOutput: extra.maxOutput ?? 16_000,
    ...(extra.env === undefined ? {} : { env: extra.env }),
  });
  started.push(preview);
  return preview;
}

async function waitFor(condition: () => boolean, withinMs = 15_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function exited(preview: PreviewProcess): Promise<number | null> {
  return new Promise((resolve) => preview.onExit(resolve));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

/** A dev server in one line: answers every request, and prints its pid once it listens. */
const SERVER = node(
  [
    "require('http')",
    ".createServer((req, res) => res.end('hello from the preview'))",
    ".listen(Number(process.env.PORT), '127.0.0.1',",
    " () => console.log('listening ' + process.pid))",
  ].join(''),
);

describe('D278 a preview runs the preview command until it is stopped', () => {
  it('serves on the free port given as PORT, and stop kills it', async () => {
    const port = await runner.freePort();
    const preview = start(SERVER, { env: { PORT: String(port) } });

    await waitFor(() => /listening \d+/.test(preview.output()));
    expect(preview.running()).toBe(true);
    expect(preview.exitCode()).toBeUndefined();

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe('hello from the preview');

    // The pid is node's — a child of the shell, not the process the runner spawned.
    const pid = Number(/listening (\d+)/.exec(preview.output())?.[1]);
    await preview.stop();
    expect(preview.running()).toBe(false);
    expect(preview.exitCode()).toBeNull();
    expect(await waitUntilDead(pid, 5_000)).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('keeps stdout and stderr interleaved as they arrived, the last maxOutput characters', async () => {
    const preview = start(
      node(
        [
          "process.stdout.write('a');",
          "setTimeout(() => process.stderr.write('b'), 150);",
          "setTimeout(() => process.stdout.write('c'), 300);",
        ].join(' '),
      ),
    );
    await exited(preview);
    expect(preview.output()).toBe('abc');

    const long = start(node("process.stdout.write('x'.repeat(50000) + 'THE END')"), {
      maxOutput: 100,
    });
    await exited(long);
    expect(long.output()).toHaveLength(100);
    expect(long.output().endsWith('THE END')).toBe(true);
  });

  it("passes the engine's environment through, with the given variables on top", async () => {
    process.env.ACE_PREVIEW_INHERITED = 'from-engine';
    try {
      const preview = start(
        node(
          "process.stdout.write(process.env.ACE_PREVIEW_INHERITED + '/' + process.env.ACE_PREVIEW_EXTRA)",
        ),
        { env: { ACE_PREVIEW_EXTRA: 'from-input' } },
      );
      await exited(preview);
      expect(preview.output()).toBe('from-engine/from-input');
    } finally {
      delete process.env.ACE_PREVIEW_INHERITED;
    }
  });

  it('runs in the worktree folder', async () => {
    const preview = start(node('process.stdout.write(process.cwd())'));
    await exited(preview);
    expect(realpathSync.native(preview.output())).toBe(realpathSync.native(cwd));
  });
});

describe('D278 a preview that ends by itself', () => {
  it('reports its exit code once it has exited', async () => {
    const preview = start(node("process.stderr.write('port in use'); process.exit(3)"));
    expect(await exited(preview)).toBe(3);
    expect(preview.running()).toBe(false);
    expect(preview.exitCode()).toBe(3);
    expect(preview.output()).toBe('port in use');
    // Stopping what has already exited changes nothing.
    await preview.stop();
    expect(preview.exitCode()).toBe(3);
  });

  it('calls each exit listener exactly once, including one added after the exit', async () => {
    const preview = start(node('setTimeout(() => process.exit(0), 200)'));
    const heard: (number | null)[] = [];
    preview.onExit((code) => heard.push(code));
    preview.onExit(() => {
      throw new Error('a listener that fails');
    });
    preview.onExit((code) => heard.push(code));

    await exited(preview);
    await preview.stop();
    expect(heard).toEqual([0, 0]);

    const late: (number | null)[] = [];
    preview.onExit((code) => late.push(code));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(late).toEqual([0]);
    expect(heard).toEqual([0, 0]);
  });

  it('reports null to the listeners when it was stopped', async () => {
    const preview = start(node('setInterval(() => {}, 1000)'));
    const exit = exited(preview);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await Promise.all([preview.stop(), preview.stop()]);
    expect(await exit).toBeNull();
    expect(preview.exitCode()).toBeNull();
  });
});

describe('D278 a preview that cannot start', () => {
  it('is a process that has already exited, for a folder that does not exist', async () => {
    const missing = join(cwd, 'not-here');
    const preview = runner.start({ command: node('0'), cwd: missing, maxOutput: 1_000 });
    expect(await exited(preview)).toBeNull();
    expect(preview.running()).toBe(false);
    expect(preview.exitCode()).toBeNull();
    expect(preview.output()).toBe(
      `Cannot start the preview: the folder ${missing} does not exist.`,
    );
    await preview.stop();
  });

  it('is a process that has already exited, for a command line that cannot be spawned', async () => {
    const preview = start('echo \0');
    const stopping = preview.stop();
    expect(await exited(preview)).toBeNull();
    await stopping;
    expect(preview.output()).toMatch(/^Cannot start the preview: /);
  });

  it.runIf(process.platform === 'win32')(
    'is a process that has exited when the shell cannot be started',
    async () => {
      const comSpec = process.env.ComSpec;
      process.env.ComSpec = join(cwd, 'no-such-cmd.exe');
      try {
        const preview = start('echo hi');
        expect(await exited(preview)).toBeNull();
        expect(preview.output()).toContain('Cannot start the preview');
      } finally {
        if (comSpec === undefined) delete process.env.ComSpec;
        else process.env.ComSpec = comSpec;
      }
    },
  );
});

describe('D278 freePort', () => {
  it('answers a port on 127.0.0.1 that can be listened on right away', async () => {
    const port = await runner.freePort();
    expect(Number.isInteger(port) && port > 0 && port < 65_536).toBe(true);

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
