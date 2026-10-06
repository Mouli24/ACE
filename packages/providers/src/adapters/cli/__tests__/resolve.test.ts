import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCommand } from '../resolve.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace resolve '));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Byte-for-byte the shim npm wrote for Claude Code 2.1.282 on this machine. */
const NATIVE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  '',
].join('\r\n');

/** The shape npm writes for a CLI whose entry point is a .js file (Codex, Gemini). */
const NODE_SHIM = [
  '@ECHO off',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  '',
].join('\r\n');

function file(path: string, content = ''): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('X1 finding a CLI without a shell (review focus 1)', () => {
  it('resolves an npm shim that points at an .exe', () => {
    const bin = join(root, 'npm');
    file(join(bin, 'claude.cmd'), NATIVE_SHIM);
    const exe = file(join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));

    expect(
      resolveCommand('claude', { platform: 'win32', env: { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' } }),
    ).toEqual({ command: exe, prefixArgs: [], path: join(bin, 'claude.cmd') });
  });

  it('resolves an npm shim that points at a .js, run by the given node', () => {
    const bin = join(root, 'npm');
    file(join(bin, 'codex.cmd'), NODE_SHIM);
    const script = file(join(bin, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));

    expect(
      resolveCommand('codex', { platform: 'win32', env: { PATH: bin }, nodeBinary: 'C:\\node\\node.exe' }),
    ).toEqual({ command: 'C:\\node\\node.exe', prefixArgs: [script], path: join(bin, 'codex.cmd') });
  });

  it('prefers a real .exe over a shim, and searches PATH in order (a dir with a space included)', () => {
    const first = join(root, 'first dir');
    const second = join(root, 'second');
    const exe = file(join(first, 'gemini.exe'));
    file(join(second, 'gemini.cmd'), NODE_SHIM);
    expect(
      resolveCommand('gemini', { platform: 'win32', env: { PATH: `${first};${second}` } })?.command,
    ).toBe(exe);
  });

  it('skips a .cmd it cannot unwrap rather than open a shell', () => {
    const bin = join(root, 'npm');
    file(join(bin, 'claude.cmd'), '@echo off\r\necho hello\r\n');
    expect(resolveCommand('claude', { platform: 'win32', env: { PATH: bin } })).toBeUndefined();
  });

  it('answers undefined when the CLI is not on PATH', () => {
    expect(
      resolveCommand('claude', { platform: 'win32', env: { PATH: join(root, 'empty') } }),
    ).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('finds a POSIX executable', () => {
    const bin = join(root, 'bin');
    const exe = file(join(bin, 'claude'));
    expect(resolveCommand('claude', { platform: 'linux', env: { PATH: bin } })).toEqual({
      command: exe,
      prefixArgs: [],
      path: exe,
    });
  });
});
