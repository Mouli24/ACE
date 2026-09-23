import { defineConfig, devices } from '@playwright/test';

/**
 * The §8.1 manual pass, driven rather than described.
 *
 * Separate from `playwright.config.ts` because these checks kill the engine on purpose: the engine
 * is started by `helpers/standalone-engine.ts` (which publishes its pid) instead of by Playwright's
 * `webServer`, so a test can kill it and bring it back without Playwright tearing the run down.
 */
const ENGINE_PORT = 47_492;
const WEB_PORT = 47_493;
const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;

export default defineConfig({
  testDir: './round-1',
  testMatch: /manual-pass\.e2e\.ts/,
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],

  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'on-first-retry',
  },

  // Only the web server here: the engine is started by the spec itself, because one of the checks
  // kills it and Playwright would read that as the run falling over.
  webServer: [
    {
      // `--host 127.0.0.1`: without it vite preview binds ::1 only and the poll below never
      // connects on Windows (D-008).
      command: `pnpm --filter @ace/web preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { VITE_ACE_URL: ENGINE_URL },
      // `preview` builds first, and the production build bundles Monaco: far past 60 s.
      timeout: 300_000,
    },
  ],
});
