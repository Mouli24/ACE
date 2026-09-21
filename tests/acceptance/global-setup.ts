import { startTestEngine, type TestEngine } from './helpers/engine.js';

let engine: TestEngine | undefined;

/**
 * Vitest global setup: one real engine for the whole acceptance suite.
 *
 * The URL and token go into the environment so a spec file needs no import from the harness —
 * Mouli's `round-N/mouli-tests-arhant.test.ts` reads `ACE_URL` and `ACE_TOKEN` and talks to the
 * engine through `@ace/sdk`, exactly as the web app does.
 */
export async function setup(): Promise<void> {
  engine = await startTestEngine();

  process.env['ACE_URL'] = engine.url;
  process.env['ACE_WS_URL'] = engine.wsUrl;
  process.env['ACE_TOKEN'] = engine.token;
  process.env['ACE_DATA_DIR'] = engine.dataDir;
}

export async function teardown(): Promise<void> {
  await engine?.stop();
  engine = undefined;
}
