import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCommandRunner } from './command-runner.js';

/*
 * D271 / ACE parity P0 §5: a project's check and setup commands run through the platform shell in
 * the task worktree, bounded by a timeout and an output tail. Every command here is `node -e`, so
 * the suite runs the same on Windows (cmd.exe) and Linux (/bin/sh).
 */

const runner = createCommandRunner();
const NODE = `"${process.execPath}"`;
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ace-cmd-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 });
});

/** A `node -e` command line; `code` must not contain a double quote. */
function node(code: string): string {
  return `${NODE} -e "${code}"`;
}

function run(command: string, extra: { timeoutMs?: number; maxOutput?: number } = {}) {
  return runner.run({
    command,
    cwd,
    timeoutMs: extra.timeoutMs ?? 20_000,
    maxOutput: extra.maxOutput ?? 16_000,
  });
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

describe('D271 check commands run through the platform shell', () => {
  it('passes on exit 0 and keeps stdout', async () => {
    const result = await run(node("process.stdout.write('all good')"));
    expect(result).toMatchObject({ exitCode: 0, output: 'all good', timedOut: false });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a non-zero exit as a result, with stderr captured', async () => {
    const result = await run(node("process.stderr.write('3 tests failed'); process.exit(2)"));
    expect(result.exitCode).toBe(2);
    expect(result.output).toBe('3 tests failed');
    expect(result.timedOut).toBe(false);
  });

  it('interleaves stdout and stderr in the order they arrived', async () => {
    const code = [
      "process.stdout.write('a');",
      "setTimeout(() => process.stderr.write('b'), 150);",
      "setTimeout(() => process.stdout.write('c'), 300);",
    ].join(' ');
    const result = await run(node(code));
    expect(result.output).toBe('abc');
  });

  it('runs a full command line — a quoted program path, arguments, a shell operator', async () => {
    const result = await run(
      `${node("process.stdout.write('one ' + process.argv[1])")} two && ${node("process.stdout.write(' three')")}`,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('one two three');
  });

  it('runs in the given folder', async () => {
    const result = await run(node('process.stdout.write(process.cwd())'));
    expect(realpathSync.native(result.output)).toBe(realpathSync.native(cwd));
  });

  it('reports a command the shell cannot find as a non-zero exit', async () => {
    const result = await run('ace-no-such-command-xyz');
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).not.toBeNull();
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('keeps only the last maxOutput characters', async () => {
    const result = await run(node("process.stdout.write('x'.repeat(50000) + 'THE END')"), {
      maxOutput: 100,
    });
    expect(result.output).toHaveLength(100);
    expect(result.output.endsWith('THE END')).toBe(true);
  });

  it('never starts the tail on the second half of a character pair', async () => {
    const result = await run(
      node('process.stdout.write(String.fromCodePoint(0x1F600).repeat(100))'),
      {
        maxOutput: 51,
      },
    );
    expect(result.output).toBe(String.fromCodePoint(0x1f600).repeat(25));
  });

  it('resolves with an error result when the command line cannot be spawned', async () => {
    const result = await run('echo \0');
    expect(result.exitCode).toBeNull();
    expect(result.output).toMatch(/^Cannot run the command: /);
  });

  it.runIf(process.platform === 'win32')(
    'resolves with an error result when the shell cannot be started',
    async () => {
      const comSpec = process.env.ComSpec;
      process.env.ComSpec = join(cwd, 'no-such-cmd.exe');
      try {
        const result = await run('echo hi');
        expect(result.exitCode).toBeNull();
        expect(result.output).toContain('Cannot run the command');
      } finally {
        if (comSpec === undefined) delete process.env.ComSpec;
        else process.env.ComSpec = comSpec;
      }
    },
  );

  it('keeps nothing when maxOutput is 0', async () => {
    const result = await run(node("process.stdout.write('hidden')"), { maxOutput: 0 });
    expect(result).toMatchObject({ exitCode: 0, output: '' });
  });

  it("passes the engine's environment through, with the given variables on top", async () => {
    process.env.ACE_CMD_RUNNER_INHERITED = 'from-engine';
    try {
      const result = await runner.run({
        command: node(
          "process.stdout.write(process.env.ACE_CMD_RUNNER_INHERITED + '/' + process.env.ACE_CMD_RUNNER_EXTRA)",
        ),
        cwd,
        env: { ACE_CMD_RUNNER_EXTRA: 'from-input' },
        timeoutMs: 20_000,
        maxOutput: 1_000,
      });
      expect(result.output).toBe('from-engine/from-input');
    } finally {
      delete process.env.ACE_CMD_RUNNER_INHERITED;
    }
  });

  it('resolves with an error result for a folder that does not exist', async () => {
    const missing = join(cwd, 'not-here');
    const result = await runner.run({
      command: node('process.exit(0)'),
      cwd: missing,
      timeoutMs: 5_000,
      maxOutput: 1_000,
    });
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain('not-here');
    expect(result.output).toContain('does not exist');
  });
});

describe('D271 a check is bounded: timeout and abort kill the whole tree', () => {
  it('kills a command that outlives its timeout, and everything it started', async () => {
    const started = Date.now();
    const result = await run(
      node('process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)'),
      { timeoutMs: 1_000 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(8_000);
    // The pid is node's — a child of the shell, not the process the runner spawned.
    const pid = Number(result.output);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(await waitUntilDead(pid, 5_000)).toBe(true);
  });

  it('kills a command when the signal aborts', async () => {
    const controller = new AbortController();
    const pending = runner.run({
      command: node('setInterval(() => {}, 1000)'),
      cwd,
      timeoutMs: 60_000,
      maxOutput: 1_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 500);
    const result = await pending;
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it('does not start a command whose signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runner.run({
      command: node("require('fs').writeFileSync('ran.txt', 'yes')"),
      cwd,
      timeoutMs: 5_000,
      maxOutput: 1_000,
      signal: controller.signal,
    });
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain('Cancelled');
  });
});
