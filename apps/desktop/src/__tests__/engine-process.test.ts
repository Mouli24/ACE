import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EngineIpcReadySchema } from '@ace/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EngineStartError, parseReady, startEngineProcess } from '../engine-process.js';
import {
  engineFailureDetail,
  packagedEngineEnv,
  packagedFolders,
  packagedLayout,
} from '../packaged.js';

/*
 * A fake engine: real Node with an IPC channel, scripted by FAKE_MODE, so the supervisor is tested
 * on the real spawn/IPC/exit path without starting the real engine (the server package's own IPC
 * test does that, and staging smoke-tests the deployed one).
 */
const FAKE_ENGINE = `
const mode = process.env.FAKE_MODE;
const ready = { type: 'ready', url: 'http://127.0.0.1:' + process.env.ACE_PORT, port: Number(process.env.ACE_PORT), token: 'fake-token' };
process.stderr.write('booting\\n');
if (process.env.ELECTRON_RUN_AS_NODE !== undefined) process.stderr.write('LEAKED ELECTRON_RUN_AS_NODE\\n');
if (mode === 'crash') { process.stderr.write('Refusing to start: ACE_PORT must be a port number\\n'); process.exit(1); }
if (mode === 'ready' || mode === 'stubborn') setTimeout(() => process.send({ type: 'hello' }), 10);
if (mode === 'ready' || mode === 'stubborn') setTimeout(() => process.send(ready), 50);
if (mode === 'die-later') { setTimeout(() => process.send(ready), 50); setTimeout(() => process.exit(3), 300); }
process.on('message', (m) => {
  if (m && m.type === 'shutdown' && mode !== 'stubborn') { process.stderr.write('shutting down\\n'); setTimeout(() => process.exit(0), 50); }
});
process.on('disconnect', () => {
  if (process.env.FAKE_MARKER) require('node:fs').writeFileSync(process.env.FAKE_MARKER, 'disconnected');
  if (mode !== 'stubborn') process.exit(0);
});
setInterval(() => {}, 1000);
`;

/** A stand-in for the shell: supervises the fake engine, says READY, then waits to be killed. */
const FAKE_SHELL = `
import { pathToFileURL } from 'node:url';
const { startEngineProcess } = await import(pathToFileURL(process.env.SUPERVISOR).href);
const engine = startEngineProcess({ nodePath: process.execPath, mainPath: process.env.FAKE_ENGINE, cwd: process.cwd(), env: process.env });
await engine.ready;
process.stdout.write('READY ' + engine.pid + '\\n');
setInterval(() => {}, 1000);
`;

let dir: string;
let script: string;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-desktop-engine-'));
  script = join(dir, 'fake-engine.cjs');
  writeFileSync(script, FAKE_ENGINE);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function start(
  mode: string,
  extra: { readyTimeoutMs?: number; env?: Record<string, string> } = {},
) {
  return startEngineProcess({
    nodePath: process.execPath,
    mainPath: script,
    cwd: dir,
    env: { ...process.env, FAKE_MODE: mode, ACE_PORT: '51234', ...extra.env },
    ...(extra.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: extra.readyTimeoutMs }),
  });
}

describe('FR-DSK-002 the packaged engine process (D296, D298)', () => {
  it('resolves ready from the IPC message, ignoring others, and shuts down cleanly', async () => {
    const engine = start('ready');
    await expect(engine.ready).resolves.toEqual({
      url: 'http://127.0.0.1:51234',
      port: 51234,
      token: 'fake-token',
    });
    await expect(engine.shutdown(5_000)).resolves.toBe('clean');
    await expect(engine.exited).resolves.toEqual({ code: 0, signal: null });
    expect(engine.tail()).toContain('shutting down');
    await expect(engine.shutdown()).resolves.toBe('already-exited');
  });

  it('never passes ELECTRON_RUN_AS_NODE to the engine', async () => {
    const engine = start('ready', { env: { ELECTRON_RUN_AS_NODE: '1' } });
    await engine.ready;
    await engine.shutdown(5_000);
    expect(engine.tail()).not.toContain('LEAKED ELECTRON_RUN_AS_NODE');
  });

  it('an engine that exits first rejects ready with its last stderr lines', async () => {
    const engine = start('crash');
    const error = await engine.ready.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EngineStartError);
    expect((error as EngineStartError).message).toBe(
      'The engine stopped before it was ready (exit code 1).',
    );
    expect((error as EngineStartError).stderr).toEqual([
      'booting',
      'Refusing to start: ACE_PORT must be a port number',
    ]);
  });

  it('an engine that never says ready is killed at the timeout', async () => {
    const engine = start('silent', { readyTimeoutMs: 500 });
    await expect(engine.ready).rejects.toThrow('The engine did not start within 1 s.');
    await engine.exited;
  });

  it('an engine that ignores shutdown is killed after the grace period', async () => {
    const engine = start('stubborn');
    await engine.ready;
    await expect(engine.shutdown(300)).resolves.toBe('killed');
  });

  it('exited tells the shell when the engine dies after ready', async () => {
    const engine = start('die-later');
    await engine.ready;
    await expect(engine.exited).resolves.toEqual({ code: 3, signal: null });
  });

  it('a shell killed outright (End task) leaves the engine to shut itself down on disconnect', async () => {
    // On Windows a child spawned the default way sits in libuv's kill-on-close job object and dies
    // with its parent, hard — the disconnect path never runs. The engine is spawned detached so
    // it does; this proves it with a real parent killed with no chance to clean up.
    const marker = join(dir, 'disconnected.txt');
    const shellScript = join(dir, 'fake-shell.mjs');
    writeFileSync(shellScript, FAKE_SHELL);
    const shell = spawn(process.execPath, ['--import', 'tsx', shellScript], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: {
        ...process.env,
        FAKE_MODE: 'ready',
        ACE_PORT: '51235',
        FAKE_MARKER: marker,
        FAKE_ENGINE: script,
        SUPERVISOR: fileURLToPath(new URL('../engine-process.ts', import.meta.url)),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const enginePid = await new Promise<number>((resolve, reject) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => reject(new Error(`no READY: ${out} ${err}`)), 30_000);
      shell.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const match = /READY (\d+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      shell.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    });

    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(shell.pid), '/F'], { stdio: 'ignore' });
    } else {
      shell.kill('SIGKILL');
    }

    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
      timeout: 10_000,
      interval: 100,
    });
    await vi.waitFor(() => expect(alive(enginePid)).toBe(false), {
      timeout: 10_000,
      interval: 100,
    });
  }, 60_000);

  it('a missing node.exe fails the start instead of hanging', async () => {
    const engine = startEngineProcess({
      nodePath: join(dir, 'no-such-node.exe'),
      mainPath: script,
      cwd: dir,
      env: {},
    });
    await expect(engine.ready).rejects.toBeInstanceOf(EngineStartError);
    expect(engine.tail().join('\n')).toMatch(/ENOENT/);
  });
});

describe('FR-DSK-002 the ready message (D296)', () => {
  const ready = { type: 'ready', url: 'http://127.0.0.1:4848', port: 4848, token: 't'.repeat(64) };

  it.each([
    ['a ready message', ready],
    ['a trailing slash', { ...ready, url: 'http://127.0.0.1:4848/' }],
    ['another type', { ...ready, type: 'hello' }],
    ['a remote url', { ...ready, url: 'http://10.0.0.1:4848' }],
    ['https', { ...ready, url: 'https://127.0.0.1:4848' }],
    ['a bad port', { ...ready, port: 0 }],
    ['an empty token', { ...ready, token: '' }],
    ['not a url', { ...ready, url: 'nope' }],
    ['null', null],
  ])('the shell’s check agrees with EngineIpcReadySchema on %s', (_label, message) => {
    expect(parseReady(message) !== undefined).toBe(EngineIpcReadySchema.safeParse(message).success);
  });
});

describe('FR-DSK-002 the packaged layout (D298)', () => {
  it('finds node, the engine and the SPA beside the asar', () => {
    expect(packagedLayout(join('C:', 'ACE', 'resources'))).toEqual({
      nodePath: join('C:', 'ACE', 'resources', 'node', 'node.exe'),
      engineMain: join('C:', 'ACE', 'resources', 'engine', 'dist', 'main.js'),
      webDir: join('C:', 'ACE', 'resources', 'web'),
    });
  });

  it('keeps data under userData, never ~/.ace, and works in Documents\\ACE', () => {
    expect(
      packagedFolders({ userData: join('C:', 'AppData', 'ACE'), documents: join('C:', 'Docs') }),
    ).toEqual({
      dataDir: join('C:', 'AppData', 'ACE', 'data'),
      logDir: join('C:', 'AppData', 'ACE', 'data', 'logs'),
      workDir: join('C:', 'Docs', 'ACE'),
    });
  });

  it('gives the engine its data dir, port and SPA, and never ELECTRON_RUN_AS_NODE', () => {
    const env = packagedEngineEnv(
      { PATH: 'C:\\bin', ELECTRON_RUN_AS_NODE: '1', ACE_PORT: '4747' },
      { dataDir: 'D', port: 51234, webDir: 'W' },
    );
    expect(env).toEqual({
      PATH: 'C:\\bin',
      ACE_DATA_DIR: 'D',
      ACE_PORT: '51234',
      ACE_WEB_DIR: 'W',
    });
  });

  it('the failure dialog shows the last lines and the log folder', () => {
    expect(engineFailureDetail([], 'L')).toBe('The engine printed nothing.\n\nLogs: L');
    const many = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const detail = engineFailureDetail(many, 'L');
    expect(detail).toContain('line 29');
    expect(detail).not.toContain('line 14\n');
    expect(detail.endsWith('Logs: L')).toBe(true);
  });
});
