import globals from 'globals';

import { base } from '@ace/config/eslint.config.js';

// The acceptance suite is the one place that drives the real engine over HTTP and WebSocket, so it
// is allowed both Node APIs and the workspace packages; the layering rules that keep engine and web
// apart do not apply to a black-box test of the two together.
export default [
  {
    /*
     * Playwright's own output. Both are git-ignored, so a clean clone never sees them — but after a
     * local run they sit in this package and ESLint reads them, and the trace viewer's bundled
     * JavaScript fails half the rules in the shared config. Linting a report tells nobody anything.
     */
    ignores: ['playwright-report/**', 'test-results/**'],
  },
  ...base,
  {
    // The fixture generator is a standalone Node script, run by hand rather than by vitest.
    files: ['fixtures/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
];
