import { homedir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_WEB_ORIGIN } from '@ace/contracts';

import { readyLine, startEngine, type RunningEngine } from './server.js';

export type SignalName = 'SIGINT' | 'SIGTERM';

export interface CliIo {
  env?: Record<string, string | undefined>;
  stdout?: { write(text: string): void };
  stderr?: { write(text: string): void };
  /** Injectable so the ordering below can be asserted without sending real signals. */
  onSignal?: (signal: SignalName, handler: () => void) => void;
  exit?: (code: number) => void;
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

  const engine = await startEngine({ dataDir: resolveDataDir(env), env });
  const shutdown = createShutdownHandler(engine, exit);

  onSignal('SIGINT', () => shutdown('SIGINT'));
  onSignal('SIGTERM', () => shutdown('SIGTERM'));

  stdout.write(`${readyLine(engine.url, DEFAULT_WEB_ORIGIN, engine.token)}\n`);

  return { engine, shutdown };
}

/** Report a start-up failure the way a terminal user needs to see it (FR-SYS-010, TC-SYS-011). */
export function reportStartupFailure(error: unknown, io: CliIo = {}): void {
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((code: number) => process.exit(code));

  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
