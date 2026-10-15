import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The cross-test suite (CLAUDE.md §6.2): Vitest driving the **real** engine over HTTP and
 * WebSocket, on a temp database with the mock provider. It boots once in globalSetup and every
 * spec talks to it through `ACE_URL` / `ACE_TOKEN`.
 *
 * `root` is pinned to this directory because the suite is launched from the workspace root
 * (`pnpm test:acceptance`), and without it the include globs would resolve against the repo root.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    globalSetup: ['./global-setup.ts'],
    include: ['round-*/*.test.ts', 'product-gaps/*.test.ts', 'helpers/*.test.ts'],
    // One engine, one database: specs must not run concurrently against shared state.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
