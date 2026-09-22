import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The nightly suite (CLAUDE.md §2, `pnpm test:providers`): `*.provider.test.ts` files tagged
 * `@provider`, which call real endpoints with real keys. Excluded from `pnpm test`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@ace/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
      '@ace/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['src/**/*.provider.test.ts'], testTimeout: 60_000, passWithNoTests: true },
});
