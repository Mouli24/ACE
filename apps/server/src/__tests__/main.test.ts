import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { HealthResponseSchema } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/** What `stdio: ['ignore', 'pipe', 'pipe']` actually produces. */
type SpawnedEngine = ChildProcessByStdio<null, Readable, Readable>;

const MAIN = fileURLToPath(new URL('../main.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

let dir: string;
let child: SpawnedEngine | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-main-'));
});

afterEach(() => {
  child?.kill();
  child = undefined;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may still hold the SQLite handle; temp is reclaimed by the OS.
  }
});

/** Start `ace-engine` the way a user does, and wait for the §2.10 line. */
function startProcess(env: Record<string, string>): Promise<{
  banner: string;
  proc: SpawnedEngine;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}> {
  const proc = spawn(process.execPath, ['--import', 'tsx', MAIN], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;

  // Both halves matter: `code: null, signal: 'SIGTERM'` means Node's default action killed the
  // process because no handler was installed, which is a different bug from exiting non-zero.
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.on('exit', (code, signal) => resolve({ code, signal })),
  );

  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(
      () => reject(new Error(`engine did not start.\nstdout: ${out}\nstderr: ${err}`)),
      45_000,
    );

    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n').find((l) => l.startsWith('ACE engine ready'));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve({ banner: line.trim(), proc, exited });
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`engine exited before it was ready.\nstdout: ${out}\nstderr: ${err}`));
    });
  });
}

describe('FR-SYS-001 ace-engine as a process', () => {
  it('prints the §2.10 ready line and serves health on the printed URL', async () => {
    const { banner } = await startProcess({ ACE_DATA_DIR: dir, ACE_PORT: '47599' });

    expect(banner).toMatch(
      /^ACE engine ready · http:\/\/127\.0\.0\.1:47599 · open http:\/\/localhost:5173\/\?token=[0-9a-f]{64}$/,
    );

    const token = banner.split('token=')[1] as string;
    const response = await fetch('http://127.0.0.1:47599/api/v1/health', {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(HealthResponseSchema.parse(await response.json()).db).toBe('ok');
  }, 60_000);

  it('refuses to start on an invalid config file, saying why (TC-SYS-011)', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'ace.config.json'), JSON.stringify({ port: 99_999 }));

    const proc = spawn(process.execPath, ['--import', 'tsx', MAIN], {
      cwd: REPO_ROOT,
      env: { ...process.env, ACE_DATA_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => proc.on('exit', resolve));

    expect(code).toBe(1);
    expect(stderr).toContain('Refusing to start');
    expect(stderr).toContain('port');
  }, 60_000);
});

describe('FR-SYS-008 graceful shutdown', () => {
  it('stops cleanly on a termination signal sent the instant it says it is ready', async () => {
    // Sent with no delay on purpose. The banner is the readiness announcement, so a signal may
    // arrive the moment after it; if the handlers were installed any later than the banner, the
    // default action would kill the process and this would come back as signal SIGTERM.
    const { proc, exited } = await startProcess({ ACE_DATA_DIR: dir, ACE_PORT: '47598' });

    proc.kill('SIGTERM');
    const { code, signal } = await exited;

    if (process.platform === 'win32') {
      // Windows has no signal delivery: Node maps .kill() to TerminateProcess, so no handler can
      // run. That the process ends is all this can assert here; the handler itself is covered by
      // the in-process tests in cli.test.ts.
      expect(code === null || typeof code === 'number').toBe(true);
      return;
    }

    expect(signal).toBeNull();
    expect(code).toBe(0);
  }, 60_000);

  it('releases the port, so the next start can bind it', async () => {
    const first = await startEngine({ dataDir: dir, port: 47_597, env: {} });
    await first.stop();

    const second: RunningEngine = await startEngine({ dataDir: dir, port: 47_597, env: {} });
    expect(second.port).toBe(47_597);
    await second.stop();
  }, 60_000);

  it('is safe to stop twice', async () => {
    const engine = await startEngine({ dataDir: dir, port: 0, env: {} });

    await engine.stop();
    await expect(engine.stop()).resolves.toBeUndefined();
  }, 60_000);
});
