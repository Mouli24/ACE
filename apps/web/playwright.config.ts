import { defineConfig, devices } from '@playwright/test';

/**
 * The web suite runs against the MSW mocks (VITE_ACE_MOCK=1): no engine, no env vars, no keys.
 * Cross-tests against the real engine live in tests/acceptance (CLAUDE.md §6.2).
 */
/** `ACE_E2E_PORT` lets parallel worktrees each serve their own build instead of reusing another's. */
const PORT = Number(process.env['ACE_E2E_PORT'] ?? 5174);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `pnpm vite --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    env: { VITE_ACE_MOCK: '1' },
    timeout: 120_000,
  },
});
