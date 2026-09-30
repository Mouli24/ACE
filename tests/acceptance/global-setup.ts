import { startTestEngine, type TestEngine } from './helpers/engine.js';
import { createTestClock, startTestControl, type TestControl } from './helpers/test-control.js';

let engine: TestEngine | undefined;
let control: TestControl | undefined;

/**
 * Vitest global setup: one real engine for the whole acceptance suite.
 *
 * The URL and token go into the environment so a spec file needs no import from the harness —
 * Mouli's `round-N/mouli-tests-arhant.test.ts` reads `ACE_URL` and `ACE_TOKEN` and talks to the
 * engine through `@ace/sdk`, exactly as the web app does.
 *
 * The engine's artifact store runs on a clock the harness holds (Arch §15.4, D-070), and
 * `ACE_TEST_CONTROL_URL` is the loopback lever a spec uses to move it and run one retention sweep
 * (`helpers/test-control.ts`) — the harness's, not a route of the engine's API.
 */
export async function setup(): Promise<void> {
  const clock = createTestClock();
  engine = await startTestEngine({ clock: clock.now });
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
}
