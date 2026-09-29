import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_MAX_OLD_SPACE_MB, RUN_DIR_NAME, prepareCodeRun } from './languages.js';

let sandboxDir: string;
beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), 'ace-lang-'));
});
afterEach(() => {
  rmSync(sandboxDir, { recursive: true, force: true });
});

describe('FR-TOOL-004 building a code run', () => {
  it('runs JavaScript with a memory cap, a network-deny prelude and a main module', () => {
    const prepared = prepareCodeRun({ sandboxDir, language: 'javascript', code: 'console.log(1)', timeoutMs: 5_000 });
    if ('unavailable' in prepared) throw new Error('js is never unavailable');

    expect(prepared.spec.command).toBe(process.execPath);
    expect(prepared.spec.args[0]).toBe(`--max-old-space-size=${DEFAULT_MAX_OLD_SPACE_MB}`);
    expect(prepared.spec.args).toContain('-r');
    expect(prepared.spec.workingDirectory).toBe(sandboxDir);

    const preludePath = prepared.spec.args[prepared.spec.args.indexOf('-r') + 1] ?? '';
    expect(readFileSync(preludePath, 'utf8')).toContain('deny');
    expect(existsSync(join(sandboxDir, RUN_DIR_NAME, 'main.mjs'))).toBe(true);
    // The scrubbed environment came along.
    expect(prepared.spec.env?.ACE_SANDBOX).toBe('1');
  });

  it('reports python unavailable when there is no interpreter, rather than a spawn error', () => {
    const prepared = prepareCodeRun({
      sandboxDir,
      language: 'python',
      code: 'print(1)',
      timeoutMs: 5_000,
      pythonPath: null,
    });
    expect(prepared).toEqual({ unavailable: 'python' });
  });

  it('prepends a socket-deny prelude to python code when an interpreter is pinned', () => {
    const prepared = prepareCodeRun({
      sandboxDir,
      language: 'python',
      code: 'print("hi")',
      timeoutMs: 5_000,
      pythonPath: 'python3',
    });
    if ('unavailable' in prepared) throw new Error('pinned python is available');
    expect(prepared.spec.command).toBe('python3');
    const main = readFileSync(join(sandboxDir, RUN_DIR_NAME, 'main.py'), 'utf8');
    expect(main).toContain('_ace_denied');
    expect(main).toContain('print("hi")');
  });

  it('runs shell through /bin/sh on POSIX', () => {
    const prepared = prepareCodeRun({
      sandboxDir,
      language: 'shell',
      code: 'echo hi',
      timeoutMs: 5_000,
      platform: 'linux',
    });
    if ('unavailable' in prepared) throw new Error('shell is never unavailable');
    expect(prepared.spec.command).toBe('/bin/sh');
    expect(existsSync(join(sandboxDir, RUN_DIR_NAME, 'main.sh'))).toBe(true);
  });

  it('runs shell through cmd.exe on Windows', () => {
    const prepared = prepareCodeRun({
      sandboxDir,
      language: 'shell',
      code: 'echo hi',
      timeoutMs: 5_000,
      platform: 'win32',
    });
    if ('unavailable' in prepared) throw new Error('shell is never unavailable');
    expect(prepared.spec.command.toLowerCase()).toContain('cmd');
    expect(prepared.spec.args).toContain('/c');
    expect(existsSync(join(sandboxDir, RUN_DIR_NAME, 'main.cmd'))).toBe(true);
  });
});
