import { processIpc, reportStartupFailure, runEngine } from './cli.js';

/**
 * `ace-engine` — the local engine entry point.
 *
 * Nothing but wiring to the real `process`: everything it does lives in `cli.ts`, where it can be
 * tested without spawning anything. `main.test.ts` additionally starts this file as a real
 * subprocess, which is the only way to prove the banner and the exit code a user actually sees.
 * The IPC channel is the desktop app's, when it started this process (D296); otherwise there is none.
 */
runEngine({ ipc: processIpc() }).catch((error: unknown) => reportStartupFailure(error));
