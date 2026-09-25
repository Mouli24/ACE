import { defineConfig } from '@playwright/test';

/**
 * The end-to-end half of cross-testing (CLAUDE.md §6.2): Playwright driving the real UI against the
 * real engine.
 *
 * `webServer` starts both sides. The engine comes up first on a fixed port with a temp data
 * directory; the web app is served by `pnpm --filter @ace/web preview` and pointed at it through
 * VITE_ACE_URL. `baseURL` carries `?token=` because that is how the web app receives the session
 * token on first load (§2.10) before stashing it in sessionStorage.
 *
 * This config exists now so Mouli's suite has somewhere to land. It cannot run until `apps/web`
 * exists, which is why the root `test:acceptance` script and CI both skip the Playwright half
 * until then.
 */
const ENGINE_PORT = 47_470;
const WEB_PORT = 47_471;
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;

export default defineConfig({
  // Every round's e2e cross-test, not just round 1: the gate asks for `pnpm test:acceptance` to run
  // both of a round's files, and a new round-N folder should need no change here.
  testDir: '.',
  testMatch: /round-\d+[\/].*\.e2e\.ts/,
  // The §8 manual pass starts and kills its own engine, so it cannot run against the `webServer`
  // below; it has its own config and its own `pnpm test:manual-pass`.
  testIgnore: /manual-pass\.e2e\.ts/,
  // a real engine, a real production build and a real browser: 60 s is too tight for the
  // config-panel tests, which make one HTTP round trip per field.
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  // One retry, so a trace is captured for a failure without paying for it on the happy path.
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    // Tracing snapshots the DOM after every action; on a React Flow canvas with a config panel
    // that costs minutes per test, which is what pushed these past the timeout. Only on a retry.
    trace: 'on-first-retry',
  },

  webServer: [
    {
      command: `node --import tsx helpers/start-for-playwright.ts ${ENGINE_PORT} ${WEB_PORT}`,
      url: `${ENGINE_URL}/api/v1/health`,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 120_000,
    },
    {
      // `--host 127.0.0.1`: without it vite preview binds ::1 only, and the 127.0.0.1 poll below
      // (and `baseURL`) never connect on Windows.
      command: `pnpm --filter @ace/web preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { VITE_ACE_URL: ENGINE_URL },
      // `preview` builds first (D27), and the production build bundles Monaco: far past 60 s.
      timeout: 300_000,
    },
  ],
});
