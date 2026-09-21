import { homedir } from 'node:os';
import { join } from 'node:path';

import { startEngine, type RunningEngine } from './server.js';

export interface CliIo {
  env?: Record<string, string | undefined>;
  stderr?: { write(text: string): void };
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
 * Start the engine for the CLI and hand back the handler the process should attach to its signals.
 * Everything here is testable in-process; `main.ts` is only the wiring to the real `process`.
 */
export async function runEngine(io: CliIo = {}): Promise<{
  engine: RunningEngine;
  shutdown: (signal: string) => void;
}> {
  const env = io.env ?? process.env;
  const exit = io.exit ?? ((code: number) => process.exit(code));

  const engine = await startEngine({ dataDir: resolveDataDir(env), env, banner: true });
  return { engine, shutdown: createShutdownHandler(engine, exit) };
}

/** Report a start-up failure the way a terminal user needs to see it (FR-SYS-010, TC-SYS-011). */
export function reportStartupFailure(error: unknown, io: CliIo = {}): void {
  const stderr = io.stderr ?? process.stderr;
  const exit = io.exit ?? ((code: number) => process.exit(code));

  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
}
