import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@ace/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
      '@ace/engine': fileURLToPath(new URL('../../packages/engine/src/index.ts', import.meta.url)),
      // Without this the server tests ran a stale `dist/` of the adapters whenever it lagged src.
      '@ace/providers': fileURLToPath(
        new URL('../../packages/providers/src/index.ts', import.meta.url),
      ),
      '@ace/storage-local': fileURLToPath(
        new URL('../../packages/storage-local/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      // main.ts is process wiring only — three lines attaching cli.ts to the real `process`.
      // It runs in a subprocess in main.test.ts, which V8 coverage in this process cannot see.
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/main.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
