import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startEngine, type RunningEngine } from '@ace/server';

export interface TestEngine {
  url: string;
  wsUrl: string;
  token: string;
  dataDir: string;
  stop(): Promise<void>;
}

/**
 * Start the real engine for an acceptance run.
 *
 * Deliberately `startEngine` from `@ace/server` rather than a re-wiring of the same parts: an
 * acceptance test is only worth running if what it drives is the process a user would start.
 *
 * Port 0 lets the OS pick a free port, so a suite never collides with an engine the developer
 * already has running, and the data directory is a fresh temp folder, so `pnpm test:acceptance`
 * needs no env var and touches nothing in `~/.ace`.
 */
export interface StartTestEngineOptions {
  /** A fixed port, for Playwright's webServer which must be told where to poll. Default: any free one. */
  port?: number;
}

export async function startTestEngine(options: StartTestEngineOptions = {}): Promise<TestEngine> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ace-acceptance-'));

  let engine: RunningEngine;
  try {
    // `env: {}` so an ACE_PORT or ACE_DATA_DIR in the developer's shell cannot reach the suite.
    engine = await startEngine({ dataDir, port: options.port ?? 0, env: {} });
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    url: engine.url,
    wsUrl: engine.wsUrl,
    token: engine.token,
    dataDir,

    async stop() {
      await engine.stop();
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Windows can hold the SQLite WAL handle briefly after close; the OS reclaims temp itself.
      }
    },
  };
}

/** Headers every REST call in the suite needs (§2.8). */
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}
