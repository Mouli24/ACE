import { webApp } from '@ace/config/eslint.config.js';

export default [...webApp, { ignores: ['public/**', 'playwright-report/**', 'test-results/**'] }];
