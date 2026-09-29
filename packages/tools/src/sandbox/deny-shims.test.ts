import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DENIED_COMMANDS, DENY_SHIM_DIR_NAME, writeDenyShims } from './deny-shims.js';
import { NETWORK_DENIED_MESSAGE, sandboxEnv } from './env.js';

let sandboxDir: string;

beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), 'ace-shims-'));
});

afterEach(() => {
  rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('NFR-SEC-04 deny shims', () => {
  it('writes an executable POSIX shim for every denied command', () => {
    const dir = writeDenyShims(sandboxDir, 'linux');

    expect(dir).toBe(join(sandboxDir, DENY_SHIM_DIR_NAME));
    for (const command of DENIED_COMMANDS) {
      const file = join(dir, command);
      const body = readFileSync(file, 'utf8');
      expect(body.startsWith('#!/bin/sh\n'), command).toBe(true);
      expect(body).toContain(`${NETWORK_DENIED_MESSAGE} (${command})`);
      expect(body).toContain('exit 1');
      if (process.platform !== 'win32') {
        expect(statSync(file).mode & 0o111, command).not.toBe(0);
      }
    }
  });

  it('writes a .cmd shim for every denied command on Windows', () => {
    const dir = writeDenyShims(sandboxDir, 'win32');

    for (const command of DENIED_COMMANDS) {
      const body = readFileSync(join(dir, `${command}.cmd`), 'utf8');
      expect(body).toContain(`${NETWORK_DENIED_MESSAGE} (${command})`);
      expect(body).toContain('exit /b 1');
      expect(existsSync(join(dir, command)), command).toBe(false);
    }
  });

  it('shims the tools an agent reaches for to open a socket', () => {
    for (const command of ['curl', 'wget', 'nc', 'ssh', 'git', 'pip', 'npm']) {
      expect(DENIED_COMMANDS).toContain(command);
    }
  });

  it('is idempotent', () => {
    const first = writeDenyShims(sandboxDir, 'linux');
    const second = writeDenyShims(sandboxDir, 'linux');
    expect(second).toBe(first);
    expect(readFileSync(join(second, 'curl'), 'utf8')).toContain(NETWORK_DENIED_MESSAGE);
  });

  it.runIf(process.platform !== 'win32')('makes `curl` in a sandboxed shell fail with the refusal', () => {
    const dir = writeDenyShims(sandboxDir);
    const result = spawnSync('/bin/sh', ['-c', 'curl https://example.com'], {
      cwd: sandboxDir,
      env: sandboxEnv({ sandboxDir, denyShimDir: dir }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${NETWORK_DENIED_MESSAGE} (curl)`);
  });

  it.runIf(process.platform === 'win32')('makes `curl` in a sandboxed cmd.exe fail with the refusal', () => {
    const dir = writeDenyShims(sandboxDir);
    const result = spawnSync('cmd.exe', ['/d', '/c', 'curl https://example.com'], {
      cwd: sandboxDir,
      env: sandboxEnv({ sandboxDir, denyShimDir: dir }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${NETWORK_DENIED_MESSAGE} (curl)`);
  });
});
