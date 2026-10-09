import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { EngineToShellMessageSchema } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createShutdownHandler,
  processIpc,
  reportStartupFailure,
  resolveDataDir,
  runEngine,
  type EngineIpc,
} from '../cli.js';
import type { RunningEngine } from '../server.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-cli-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may still hold the SQLite handle; temp is reclaimed by the OS.
  }
});

describe('§2.1 data directory', () => {
  it('uses ACE_DATA_DIR when it is set', () => {
    expect(resolveDataDir({ ACE_DATA_DIR: 'D:/custom' })).toBe('D:/custom');
  });

  it.each([
    ['unset', {}],
    ['empty', { ACE_DATA_DIR: '' }],
  ])('falls back to ~/.ace when it is %s', (_label, env) => {
    expect(resolveDataDir(env)).toBe(join(homedir(), '.ace'));
  });
});

describe('FR-SYS-008 shutdown handler', () => {
  function fakeEngine(): { engine: RunningEngine; stops: number } {
    const state = { stops: 0 };
    const engine = {
      stop: async () => {
        state.stops += 1;
      },
      logger: { info: () => undefined },
    } as unknown as RunningEngine;
    return { engine, get stops() {
      return state.stops;
    } };
  }

  it('stops the engine and exits 0', async () => {
    const { engine } = fakeEngine();
    const codes: number[] = [];

    createShutdownHandler(engine, (code) => codes.push(code))('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(codes).toEqual([0]);
  });

  it('ignores a second signal while the first shutdown is still draining', async () => {
    const holder = fakeEngine();
    const codes: number[] = [];
    const shutdown = createShutdownHandler(holder.engine, (code) => codes.push(code));

    shutdown('SIGINT');
    shutdown('SIGINT');
    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(holder.stops).toBe(1);
    expect(codes).toEqual([0]);
  });

  it('exits 1 when stopping fails, rather than hanging', async () => {
    const engine = {
      stop: async () => {
        throw new Error('the socket would not close');
      },
      logger: { info: () => undefined },
    } as unknown as RunningEngine;
    const codes: number[] = [];

    createShutdownHandler(engine, (code) => codes.push(code))('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(codes).toEqual([1]);
  });
});

describe('TC-SYS-011 start-up failure is reported', () => {
  it('writes the message and exits 1', () => {
    const written: string[] = [];
    const codes: number[] = [];

    reportStartupFailure(new Error('Refusing to start: port must be 1..65535'), {
      stderr: { write: (text) => written.push(text) },
      exit: (code) => codes.push(code),
    });

    expect(written).toEqual(['Refusing to start: port must be 1..65535\n']);
    expect(codes).toEqual([1]);
  });

  it('copes with something thrown that is not an Error', () => {
    const written: string[] = [];

    reportStartupFailure('just a string', {
      stderr: { write: (text) => written.push(text) },
      exit: () => undefined,
    });

    expect(written).toEqual(['just a string\n']);
  });
});

describe('runEngine wiring', () => {
  it('starts a real engine at the resolved data directory and hands back a shutdown', async () => {
    // A real port, not 0: the CLI path goes through loadEngineConfig, which rejects 0 as a
    // user-facing value. `startEngine({ port: 0 })` is the in-process escape hatch for tests.
    const { engine, shutdown } = await runEngine({
      env: { ACE_DATA_DIR: dir, ACE_PORT: '47596' },
      exit: () => undefined,
      stdout: { write: () => undefined },
      onSignal: () => undefined,
    });

    expect(engine.url).toBe('http://127.0.0.1:47596');
    expect(typeof shutdown).toBe('function');

    await engine.stop();
  }, 30_000);

  it('installs the signal handlers BEFORE it announces readiness (FR-SYS-008)', async () => {
    // The regression this pins: the banner is the readiness announcement, so a supervisor or a
    // person can send SIGTERM the instant after it. Printing it first leaves a window where the
    // default action kills the engine instead of shutting it down. CI hit that window reliably.
    const order: string[] = [];

    const { engine } = await runEngine({
      env: { ACE_DATA_DIR: dir, ACE_PORT: '47594' },
      exit: () => undefined,
      stdout: { write: () => order.push('banner') },
      onSignal: (signal) => order.push(`handler:${signal}`),
    });

    expect(order).toEqual(['handler:SIGINT', 'handler:SIGTERM', 'banner']);

    await engine.stop();
  }, 30_000);

  it('announces readiness with the §2.10 line, carrying the live url and token', async () => {
    const written: string[] = [];

    const { engine } = await runEngine({
      env: { ACE_DATA_DIR: dir, ACE_PORT: '47593' },
      exit: () => undefined,
      stdout: { write: (text) => written.push(text) },
      onSignal: () => undefined,
    });

    expect(written).toEqual([
      `ACE engine ready · http://127.0.0.1:47593 · open http://localhost:5173/?token=${engine.token}
`,
    ]);

    await engine.stop();
  }, 30_000);

  it('defaults to the real process stdout and signal handlers when none are injected', async () => {
    // Exercises the production wiring itself, not a stand-in for it. The listeners it registers on
    // this process are removed again so they cannot affect the rest of the run.
    const before = {
      int: process.listenerCount('SIGINT'),
      term: process.listenerCount('SIGTERM'),
    };
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((text: string) => {
      written.push(String(text));
      return true;
    }) as typeof process.stdout.write;

    try {
      const { engine } = await runEngine({
        env: { ACE_DATA_DIR: dir, ACE_PORT: '47592' },
        exit: () => undefined,
      });

      expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
      expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
      expect(written.join('')).toContain('ACE engine ready');

      await engine.stop();
    } finally {
      process.stdout.write = original;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        const handlers = process.listeners(signal);
        const added = handlers[handlers.length - 1];
        if (added !== undefined) process.removeListener(signal, added as () => void);
      }
    }
  }, 30_000);

  it('propagates a bad config rather than starting anyway (TC-SYS-011)', async () => {
    writeFileSync(join(dir, 'ace.config.json'), JSON.stringify({ logLevel: 'chatty' }));

    await expect(
      runEngine({
        env: { ACE_DATA_DIR: dir },
        exit: () => undefined,
        stdout: { write: () => undefined },
        onSignal: () => undefined,
      }),
    ).rejects.toThrow(/Refusing to start/);
  }, 30_000);
});

describe('FR-DSK-002 the desktop app’s IPC channel (D296)', () => {
  /** A stand-in for the parent's channel: records what is sent, lets the test deliver. */
  function fakeIpc() {
    const sent: unknown[] = [];
    let onMessage: ((message: unknown) => void) | undefined;
    let onDisconnect: (() => void) | undefined;
    const ipc: EngineIpc = {
      send: (message) => sent.push(message),
      onMessage: (handler) => {
        onMessage = handler;
      },
      onDisconnect: (handler) => {
        onDisconnect = handler;
      },
    };
    return {
      ipc,
      sent,
      deliver: (message: unknown) => onMessage?.(message),
      disconnect: () => onDisconnect?.(),
    };
  }

  async function start(port: number, channel: ReturnType<typeof fakeIpc>, codes: number[]) {
    const order: string[] = [];
    const { engine } = await runEngine({
      env: { ACE_DATA_DIR: dir, ACE_PORT: String(port) },
      exit: (code) => codes.push(code),
      stdout: { write: () => order.push('banner') },
      onSignal: () => undefined,
      ipc: {
        ...channel.ipc,
        send: (message) => {
          order.push('ready');
          channel.ipc.send(message);
        },
      },
    });
    return { engine, order };
  }

  it('sends ready — url, port, token — right after the banner', async () => {
    const channel = fakeIpc();
    const { engine, order } = await start(47621, channel, []);

    expect(order).toEqual(['banner', 'ready']);
    expect(channel.sent).toEqual([
      { type: 'ready', url: 'http://127.0.0.1:47621', port: 47621, token: engine.token },
    ]);
    expect(EngineToShellMessageSchema.parse(channel.sent[0])).toEqual(channel.sent[0]);

    await engine.stop();
  }, 30_000);

  it('a shutdown message runs the Ctrl-C shutdown and exits 0, once', async () => {
    const channel = fakeIpc();
    const codes: number[] = [];
    const { engine } = await start(47622, channel, codes);

    channel.deliver({ type: 'something-else' });
    channel.deliver('shutdown');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(codes).toEqual([]);

    channel.deliver({ type: 'shutdown' });
    channel.deliver({ type: 'shutdown' });
    channel.disconnect();
    await vi.waitFor(() => expect(codes).toEqual([0]), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(codes).toEqual([0]);

    // stop() already ran; a second call is the no-op it always is.
    await engine.stop();
  }, 30_000);

  it('a closed channel (the desktop app died) shuts down the same way', async () => {
    const channel = fakeIpc();
    const codes: number[] = [];
    await start(47623, channel, codes);

    channel.disconnect();
    await vi.waitFor(() => expect(codes).toEqual([0]), { timeout: 10_000 });
  }, 30_000);

  it('without a channel nothing is sent or listened to (a terminal start is unchanged)', async () => {
    expect(processIpc({ send: undefined } as unknown as NodeJS.Process)).toBeUndefined();
  });

  it('processIpc wraps a real parent channel', () => {
    const sent: unknown[] = [];
    const listeners: string[] = [];
    const proc = {
      send: (message: unknown) => {
        sent.push(message);
        return true;
      },
      on: (event: string) => {
        listeners.push(event);
        return proc;
      },
    };
    const ipc = processIpc(proc as unknown as NodeJS.Process);
    ipc?.onMessage(() => undefined);
    ipc?.onDisconnect(() => undefined);
    ipc?.send({ type: 'ready', url: 'http://127.0.0.1:1', port: 1, token: 't' });
    expect(listeners).toEqual(['message', 'disconnect']);
    expect(sent).toHaveLength(1);

    const closed = processIpc({
      send: () => {
        throw new Error('ERR_IPC_CHANNEL_CLOSED');
      },
      on: () => undefined,
    } as unknown as NodeJS.Process);
    expect(() =>
      closed?.send({ type: 'ready', url: 'http://127.0.0.1:1', port: 1, token: 't' }),
    ).not.toThrow();
  });
});
