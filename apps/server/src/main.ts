import { homedir } from 'node:os';
import { join } from 'node:path';

import { startEngine } from './server.js';

/**
 * `ace-engine` — the local engine entry point.
 *
 * Data lives in `ACE_DATA_DIR` or `~/.ace` (§2.1). Everything else is decided by
 * `startEngine`, which the acceptance harness also uses, so what runs here and what is tested
 * end to end are the same code path.
 */
async function main(): Promise<void> {
  const dataDir = process.env['ACE_DATA_DIR'] ?? join(homedir(), '.ace');
  const engine = await startEngine({ dataDir, banner: true });

  let stopping = false;
  const shutdown = (signal: string): void => {
    // A second Ctrl-C while the first is still draining must not start a second shutdown.
    if (stopping) return;
    stopping = true;

    engine.logger.info({ subsystem: 'server', signal }, 'shutting down');
    void engine.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  // The engine could not start — a bad config file is the usual reason (FR-SYS-010, TC-SYS-011).
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
