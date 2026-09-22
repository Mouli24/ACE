import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * `pnpm test` never touches the network (CLAUDE.md §2): the real adapters are driven against
 * recorded HTTP fixtures through msw, and anything tagged `@provider` is excluded and runs only
 * under `pnpm test:providers`.
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
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.provider.test.ts'],
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
