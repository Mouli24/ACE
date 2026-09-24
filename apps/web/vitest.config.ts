import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { aliases } from './vite.config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: aliases },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.tsx'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    /**
     * A Radix menu or Select driven by userEvent takes seconds in jsdom, and v8 coverage
     * instrumentation roughly doubles it — the default 5 s budget failed three different tests
     * from one `--coverage` run to the next. This is the runner's patience, not an assertion.
     */
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/**/*.d.ts'],
      thresholds: { lines: 60, functions: 60, branches: 60, statements: 60 },
    },
  },
});
