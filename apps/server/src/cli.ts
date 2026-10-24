import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_WEB_ORIGIN,
  ShellToEngineMessageSchema,
  type EngineToShellMessage,
} from '@ace/contracts';

import { holdEngineLock, refuseSecondEngine } from './engine-lock.js';
import { readyLine, startEngine, type RunningEngine } from './server.js';

export type SignalName = 'SIGINT' | 'SIGTERM';

/**
 * The IPC channel a parent opened when it started this process (`stdio: [..., 'ipc']`) — the
 * packaged desktop app does (D296). Narrowed to what the engine uses, so a test can stand in for it.
 */
export interface EngineIpc {
  send(message: EngineToShellMessage): void;
  onMessage(handler: (message: unknown) => void): void;
  onDisconnect(handler: () => void): void;
}

export interface CliIo {
  env?: Record<string, string | undefined>;
  stdout?: { write(text: string): void };
  stderr?: { write(text: string): void };
  /** Injectable so the ordering below can be asserted without sending real signals. */
  onSignal?: (signal: SignalName, handler: () => void) => void;
  exit?: (code: number) => void;
  /**
   * The parent's IPC channel, if it opened one. Never detected here: `main.ts` passes
   * {@link processIpc}'s answer, so code that calls `runEngine` in-process — a test in a forked
   * worker, which has a channel of its own — is not wired to a parent it does not know.
   */
  ipc?: EngineIpc;
}

/** This process's IPC channel, when its parent opened one; otherwise `undefined`. */
export function processIpc(proc: NodeJS.Process = process): EngineIpc | undefined {
  if (typeof proc.send !== 'function') return undefined;
  return {
    send(message) {
      try {
        proc.send?.(message);
      } catch {
        // The parent already closed the channel; `disconnect` is on its way.
      }
    },
    onMessage(handler) {
      proc.on('message', handler);
    },
    onDisconnect(handler) {
      proc.on('disconnect', handler);
    },
  };
}

/** §2.1: data lives in `ACE_DATA_DIR`, or `~/.ace` when that is not set. */
export function resolveDataDir(env: Record<string, string | undefined>): string {
  const configured = env['ACE_DATA_DIR'];
  return configured === undefined || configured === '' ? join(homedir(), '.ace') : configured;
}

/**
 * Build the signal handler the process installs.
 *
 * Returned rather than installed so it can be tested without sending real signals: a second
 * Ctrl-C while the first shutdown is still draining must be ignored, not start a second one.
 */
export function createShutdownHandler(
  engine: RunningEngine,
  exit: (code: number) => void,
): (signal: string) => void {
  let stopping = false;

  return (signal: string) => {
    if (stopping) return;
    stopping = true;

    engine.logger.info({ subsystem: 'server', signal }, 'shutting down');
    void engine.stop().then(
      () => exit(0),
      () => exit(1),
    );
  };
}

/**
 * Start the engine for the CLI: listen, then become interruptible, then say so.
 *
 * **The order matters.** The banner is what tells the outside world the engine is up — a
 * supervisor, a test harness or a person waiting to press Ctrl-C. Printing it before the signal
 * handlers exist leaves a window in which SIGTERM takes Node's default action and kills the process
 * outright instead of running the graceful shutdown of FR-SYS-008. That window is microseconds on
 * an idle machine and reliably hit on a loaded CI runner, which is exactly how it was found.
 */
export async function runEngine(io: CliIo = {}): Promise<{
  engine: RunningEngine;
  shutdown: (signal: string) => void;
}> {
  const env = io.env ?? process.env;
  const exit = io.exit ?? ((code: number) => process.exit(code));
  const stdout = io.stdout ?? process.stdout;
  const onSignal =
    io.onSignal ??
    ((signal: SignalName, handler: () => void) => {
      process.on(signal, handler);
    });

  const dataDir = resolveDataDir(env);
  // D409: one engine per data folder — a second one says so and stops before it opens anything.
  await refuseSecondEngine(dataDir);
  const engine = await startEngine({
    dataDir,
    env,
    // PG-1.4 (D359): the product finds and starts the local Ollama; ACE_LOCAL_RUNTIME=off opts
    // out, and an engine a test suite starts (Vitest sets VITEST) never starts anything.
    autoLocalRuntime:
      env['ACE_LOCAL_RUNTIME'] !== 'off' &&
      env['VITEST'] === undefined &&
      process.env['VITEST'] === undefined,
  });
  const releaseLock = holdEngineLock(dataDir, engine.port);
  // A real process also lets go of it on any exit; one a test runs in-process keeps its own.
  if (io.exit === undefined) process.once('exit', releaseLock);
  const shutdown = createShutdownHandler(engine, (code) => {
    releaseLock();
    exit(code);
  });

  onSignal('SIGINT', () => shutdown('SIGINT'));
  onSignal('SIGTERM', () => shutdown('SIGTERM'));

  stdout.write(`${readyLine(engine.url, DEFAULT_WEB_ORIGIN, engine.token)}\n`);

  // D296: started by the desktop app. Windows has no real SIGTERM — the parent's `kill()` is a hard
  // kill — so the parent asks over IPC instead, and a parent that dies closes the channel. Either
  // way it is the same shutdown Ctrl-C runs, guarded the same way against a second request. The
  // listeners go on before `ready` is sent, for the same reason the signal handlers go on before
  // the banner.
  if (io.ipc !== undefined) {
    const ipc = io.ipc;
    ipc.onMessage((message) => {
      if (ShellToEngineMessageSchema.safeParse(message).success) shutdown('ipc:shutdown');
    });
    ipc.onDisconnect(() => shutdown('ipc:disconnect'));
    ipc.send({ type: 'ready', url: engine.url, port: engine.port, token: engine.token });
  }

  return { engine, shutdown };
}

/** Report a start-up failure the way a terminal user needs to see it (FR-SYS-010, TC-SYS-011). */
export function reportStartupFailure(error: unknown, io: CliIo = {}): void {
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((code: number) => process.exit(code));

  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
