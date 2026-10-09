import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineIpcReadySchema, HealthResponseSchema, type EngineIpcReady } from '@ace/contracts';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/*
 * D296 end to end: the BUILT engine (`dist/main.js`, what the desktop app ships), started on real
 * Node with an IPC channel the way the packaged app starts it. `main.test.ts` covers the terminal
 * start (no channel), which must stay exactly as it was.
 */

const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const MAIN = join(SERVER, 'dist', 'main.js');

function newest(dir: string): number {
  let max = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const time = statSync(join(entry.parentPath, entry.name)).mtimeMs;
    if (time > max) max = time;
  }
  return max;
}

/** Build `apps/server` when its dist is missing or older than its sources (CI's typecheck builds it). */
beforeAll(() => {
  const info = join(SERVER, 'tsconfig.tsbuildinfo');
  const stale =
    !existsSync(MAIN) || !existsSync(info) || newest(join(SERVER, 'src')) > statSync(info).mtimeMs;
  if (stale) {
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    execFileSync(process.execPath, [tsc, '--build'], { cwd: SERVER, stdio: 'pipe' });
  }
}, 120_000);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

let dir: string;
let child: ChildProcess | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-ipc-'));
});

afterEach(() => {
  if (child !== undefined && child.exitCode === null) child.kill();
  child = undefined;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Windows may still hold the SQLite handle; temp is reclaimed by the OS.
  }
});

async function startWithIpc(): Promise<{
  proc: ChildProcess;
  ready: EngineIpcReady;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}> {
  const port = await freePort();
  const proc = spawn(process.execPath, [MAIN], {
    cwd: dir,
    env: { ...process.env, ACE_DATA_DIR: dir, ACE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child = proc;
  let err = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  proc.stdout?.resume();

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(
    (resolve) => proc.once('exit', (code, signal) => resolve({ code, signal, at: Date.now() })),
  );

  const ready = await new Promise<EngineIpcReady>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready message.\nstderr: ${err}`)), 45_000);
    proc.on('message', (message) => {
      const parsed = EngineIpcReadySchema.safeParse(message);
      if (parsed.success) {
        clearTimeout(timer);
        resolve(parsed.data);
      }
    });
    void exited.then(({ code }) => {
      clearTimeout(timer);
      reject(new Error(`engine exited (${code}) before ready.\nstderr: ${err}`));
    });
  });
  expect(ready.port).toBe(port);
  return { proc, ready, exited };
}

describe('FR-DSK-002 the built engine under a desktop parent (D296)', () => {
  it('sends ready, serves /health with that token, and exits 0 on shutdown within seconds', async () => {
    const { proc, ready, exited } = await startWithIpc();

    expect(ready.url).toBe(`http://127.0.0.1:${ready.port}`);
    const health = await fetch(`${ready.url}/api/v1/health`, {
      headers: { authorization: `Bearer ${ready.token}` },
    });
    expect(health.status).toBe(200);
    HealthResponseSchema.parse(await health.json());

    const asked = Date.now();
    proc.send({ type: 'shutdown' });
    const { code, signal, at } = await exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(at - asked).toBeLessThan(10_000);
  }, 60_000);

  it('exits cleanly when the parent goes away (the channel closes)', async () => {
    const { proc, exited } = await startWithIpc();

    proc.disconnect();
    const { code, signal } = await exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 60_000);
});
