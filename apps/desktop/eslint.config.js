import { desktopApp } from '@ace/config/eslint.config.js';

export default [...desktopApp, { ignores: ['release/**', 'stage/**'] }];
