import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startEngine, type RunningEngine } from '@ace/server';

export interface TestEngine {
  url: string;
  wsUrl: string;
  token: string;
  dataDir: string;
  /** One artifact retention sweep, now, by the engine's clock (Arch §15.4) — see `test-control.ts`. */
  sweepArtifacts: RunningEngine['sweepArtifacts'];
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
  /**
   * Extra origins the engine must answer (D27). The Playwright half serves the web app from a
   * preview port that is in neither `settings.allowedOrigins` (§2.7 lists only the dev ports) nor
   * the engine's own origins, so without this every request from the page is a 403 with no
   * `Access-Control-Allow-Origin` and the browser reports "Failed to fetch".
   */
  allowedOrigins?: string[];
  /** The artifact store's clock (Arch §15.4), so a retention check can move time. Default: real time. */
  clock?: () => string;
  /** Where the canned search index's result URLs point (D-067) — the suite's local HTTP test server. */
  cannedSearchBaseUrl?: string;
}

export async function startTestEngine(options: StartTestEngineOptions = {}): Promise<TestEngine> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ace-acceptance-'));

  let engine: RunningEngine;
  try {
    // `env: {}` so an ACE_PORT or ACE_DATA_DIR in the developer's shell cannot reach the suite.
    engine = await startEngine({
      dataDir,
      port: options.port ?? 0,
      env: {},
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.cannedSearchBaseUrl === undefined
        ? {}
        : { cannedSearchBaseUrl: options.cannedSearchBaseUrl }),
    });
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  if (options.allowedOrigins && options.allowedOrigins.length > 0) {
    await allowOrigins(engine, options.allowedOrigins);
  }

  return {
    url: engine.url,
    wsUrl: engine.wsUrl,
    token: engine.token,
    dataDir,
    sweepArtifacts: () => engine.sweepArtifacts(),

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

/**
 * Append origins to `settings.allowedOrigins` through the public API, so the engine is configured
 * the way a user would configure it rather than by reaching into its database.
 */
async function allowOrigins(engine: RunningEngine, origins: string[]): Promise<void> {
  const headers = authHeaders(engine.token);
  const current = await fetch(`${engine.url}/api/v1/settings`, { headers });
  if (!current.ok) throw new Error(`could not read settings: ${current.status}`);
  const settings = (await current.json()) as { allowedOrigins: string[] };
  const merged = [...new Set([...settings.allowedOrigins, ...origins])];
  const patched = await fetch(`${engine.url}/api/v1/settings`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ allowedOrigins: merged }),
  });
  if (!patched.ok) throw new Error(`could not allow origins: ${patched.status}`);
}

/** Headers every REST call in the suite needs (§2.8). */
export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}
