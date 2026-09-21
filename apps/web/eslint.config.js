import { webApp } from '@ace/config/eslint.config.js';

export default [
  ...webApp,
  { ignores: ['public/**', 'playwright-report/**', 'test-results/**', 'dist/**'] },
  {
    // Tooling that runs in Node, not in the browser bundle.
    files: ['*.config.ts', 'e2e/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
