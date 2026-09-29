import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCAL_SCOPE, type SandboxSpec } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChildProcessSandbox, OUTPUT_CAP_BYTES } from './runner.js';
import { sandboxEnv } from './env.js';

let sandboxDir: string;
const sandbox = new ChildProcessSandbox();

beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), 'ace-runner-'));
});
afterEach(() => {
  rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function nodeSpec(code: string, timeoutMs = 10_000): SandboxSpec {
  return {
    command: process.execPath,
    args: ['-e', code],
    workingDirectory: sandboxDir,
    timeoutMs,
    env: sandboxEnv({ sandboxDir }),
  };
}

describe('FR-TOOL-004 the child-process sandbox', () => {
  it('runs a program and returns stdout and the exit code', async () => {
    const result = await sandbox.run(LOCAL_SCOPE, nodeSpec('process.stdout.write("hello"); process.exit(3)'));
    expect(result.stdout).toBe('hello');
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr', async () => {
    const result = await sandbox.run(LOCAL_SCOPE, nodeSpec('process.stderr.write("oops")'));
    expect(result.stderr).toBe('oops');
    expect(result.exitCode).toBe(0);
  });

  it('reports a spawn failure as a failed run rather than throwing', async () => {
    const result = await sandbox.run(LOCAL_SCOPE, {
      command: join(sandboxDir, 'does-not-exist-binary'),
      args: [],
      workingDirectory: sandboxDir,
      timeoutMs: 5_000,
      env: sandboxEnv({ sandboxDir }),
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('builds a scrubbed environment itself when the spec gives none', async () => {
    const result = await sandbox.run(LOCAL_SCOPE, {
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.ACE_SANDBOX || "")'],
      workingDirectory: sandboxDir,
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe('1');
  });
});

describe('TC-TOOL-004 a runaway is killed at the timeout', () => {
  it('kills `while (true) {}` and flags timedOut', async () => {
    const started = Date.now();
    const result = await sandbox.run(LOCAL_SCOPE, nodeSpec('while (true) {}', 500));
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('output is capped so a flood cannot exhaust memory', () => {
  it('truncates stdout at the cap', async () => {
    const result = await sandbox.run(
      LOCAL_SCOPE,
      nodeSpec(`const s = "x".repeat(1000); for (let i = 0; i < 3000; i++) process.stdout.write(s);`),
    );
    expect(result.stdout.length).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
  });
});
