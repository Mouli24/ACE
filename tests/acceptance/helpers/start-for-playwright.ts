import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startTestEngine } from './engine.js';

/**
 * Playwright's `webServer` runs a command, not a function, so the engine needs a tiny entry of its
 * own. It writes the token where the spec files can read it, because Playwright cannot hand an
 * environment variable back from a started server.
 */
const port = Number(process.argv[2] ?? 47_470);

// A fixed port here, not a random one: Playwright polls a URL it was given up front.
const engine = await startTestEngine({ port });

writeFileSync(
  join(process.cwd(), '.playwright-engine.json'),
  JSON.stringify({ url: engine.url, wsUrl: engine.wsUrl, token: engine.token }, null, 2),
);

process.stdout.write(`acceptance engine ready at ${engine.url}\n`);

const stop = (): void => {
  void engine.stop().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
