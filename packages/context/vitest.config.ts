import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The parser, chunker and embedder are pure, so nothing here needs a server, a database or a key (CLAUDE.md §7).
 * `@ace/contracts` and `@ace/engine` resolve to their sources, so `pnpm test` never depends on a
 * prior `pnpm build`.
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
