/**
 * PATH shims that refuse the network utilities (FR-TOOL-004, NFR-SEC-04).
 *
 * The proxy variables in `env.ts` only bind libraries that choose to read them; a shell script that
 * runs `curl https://example.com` ignores them entirely. So a folder of executables that do nothing
 * but print the refusal and exit non-zero is put *first* on the child's `PATH`. `curl` then resolves
 * to the shim, not to the real binary, on both platforms — which is the one denial mechanism that
 * works the same in `sh` and in `cmd.exe`.
 *
 * It lives at `<sandbox>/.ace-deny/`. Dot-prefixed folders are skipped when produced files are
 * collected, so the shims never come back as a `code_sandbox` artifact.
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { NETWORK_DENIED_MESSAGE } from './env.js';

/** Folder name inside the sandbox. Dot-prefixed so file collection ignores it. */
export const DENY_SHIM_DIR_NAME = '.ace-deny';

/**
 * The programs shimmed away. Everything here is a way to open a socket from a shell one-liner;
 * the list is what an agent would actually reach for, not an attempt at completeness — the
 * per-language preludes and Docker's `--network none` are what make completeness unnecessary.
 */
export const DENIED_COMMANDS: readonly string[] = [
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'rsync',
  'git',
  'pip',
  'pip3',
  'npm',
  'pnpm',
  'yarn',
  'apt',
  'apt-get',
  'brew',
  'powershell',
  'pwsh',
  'Invoke-WebRequest',
];

/**
 * Writes the shim folder and returns its absolute path. Idempotent: re-running a sandbox in the
 * same folder just rewrites the same files.
 *
 * On Windows a `.cmd` beside a bare file is what `PATHEXT` resolves, so both are written; on POSIX
 * the bare file carries a shebang and mode 0o755.
 */
export function writeDenyShims(sandboxDir: string, platform: NodeJS.Platform = process.platform): string {
  const dir = join(sandboxDir, DENY_SHIM_DIR_NAME);
  mkdirSync(dir, { recursive: true });

  for (const command of DENIED_COMMANDS) {
    if (platform === 'win32') {
      writeFileSync(
        join(dir, `${command}.cmd`),
        `@echo off\r\necho ${NETWORK_DENIED_MESSAGE} (${command}) 1>&2\r\nexit /b 1\r\n`,
        'utf8',
      );
    } else {
      const file = join(dir, command);
      writeFileSync(file, `#!/bin/sh\necho "${NETWORK_DENIED_MESSAGE} (${command})" >&2\nexit 1\n`, 'utf8');
      chmodSync(file, 0o755);
    }
  }

  return dir;
}
