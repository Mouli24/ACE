import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `pnpm test` for the tool layer needs no env var, no network, no Docker and no SearXNG
 * (CLAUDE.md §2, D13, D14): the sandbox runs through the child-process runner, `http_request` and
 * `web_fetch` are driven against an in-process HTTP server on 127.0.0.1, and `web_search` uses the
 * canned `SearchBackend`.
 *
 * The timeouts are generous because several suites really do spawn child processes and wait for a
 * runaway to be killed.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@ace/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
      '@ace/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
