/**
 * `pnpm --filter @ace/desktop dev`: start Electron on this app.
 *
 * Not `electron .` directly: a process started from VS Code's extension host — Claude Code, a VS
 * Code task — inherits `ELECTRON_RUN_AS_NODE=1`, and with it set `electron.exe` runs as plain Node
 * and the shell dies on its first `import … from 'electron'`. So the variable is dropped here.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
// The `electron` package's main answers the path of the binary (downloading it on first use).
const electronPath = createRequire(import.meta.url)('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: appDir,
  env,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
