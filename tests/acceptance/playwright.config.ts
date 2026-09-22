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
  testDir: './round-1',
  testMatch: /.*\.e2e\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },

  webServer: [
    {
      command: `node --import tsx helpers/start-for-playwright.ts ${ENGINE_PORT} ${WEB_PORT}`,
      url: `${ENGINE_URL}/api/v1/health`,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: `pnpm --filter @ace/web preview --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { VITE_ACE_URL: ENGINE_URL },
    },
  ],
});
