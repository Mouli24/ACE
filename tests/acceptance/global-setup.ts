import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startTestEngine, type TestEngine } from './helpers/engine.js';
import { createTestClock, startTestControl, type TestControl } from './helpers/test-control.js';

let engine: TestEngine | undefined;
let control: TestControl | undefined;
let pages: { origin: string; close(): Promise<void> } | undefined;

/** The round 4 local HTTP test server (`fixtures/round-4/servers/http-server.mjs`). */
async function startPageServer(): Promise<{ origin: string; close(): Promise<void> }> {
  const script = join(
    fileURLToPath(new URL('.', import.meta.url)),
    'fixtures',
    'round-4',
    'servers',
    'http-server.mjs',
  );
  const module = (await import(pathToFileURL(script).href)) as {
    startHttpFixtureServer: () => Promise<{ origin: string; close(): Promise<void> }>;
  };
  return module.startHttpFixtureServer();
}

/**
 * Vitest global setup: one real engine for the whole acceptance suite.
 *
 * The URL and token go into the environment so a spec file needs no import from the harness —
 * Mouli's `round-N/mouli-tests-arhant.test.ts` reads `ACE_URL` and `ACE_TOKEN` and talks to the
 * engine through `@ace/sdk`, exactly as the web app does.
 *
 * Two round 4 arrangements, both the harness's and neither a route of the engine's API:
 * - the artifact store runs on a clock the harness holds (Arch §15.4, D-070), and
 *   `ACE_TEST_CONTROL_URL` is the loopback lever a spec uses to move it and run one retention sweep
 *   (`helpers/test-control.ts`);
 * - the canned search index's result URLs point at the round 4 local HTTP test server, started here
 *   for the whole suite, so `search.json`'s `web_search` → `web_fetch` completes offline (D14, D-067).
 */
export async function setup(): Promise<void> {
  const clock = createTestClock();
  pages = await startPageServer();
  engine = await startTestEngine({ clock: clock.now, cannedSearchBaseUrl: pages.origin });
  control = await startTestControl({ engine, clock });

  process.env['ACE_URL'] = engine.url;
  process.env['ACE_WS_URL'] = engine.wsUrl;
  process.env['ACE_TOKEN'] = engine.token;
  process.env['ACE_DATA_DIR'] = engine.dataDir;
  process.env['ACE_TEST_CONTROL_URL'] = control.url;
}

export async function teardown(): Promise<void> {
  await control?.close();
  control = undefined;
  await engine?.stop();
  engine = undefined;
  await pages?.close();
  pages = undefined;
}
