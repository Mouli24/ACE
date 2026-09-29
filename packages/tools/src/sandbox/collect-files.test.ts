import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectProducedFiles } from './collect-files.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-collect-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('FR-TOOL-004 collecting produced files', () => {
  it('lists files with sandbox-relative, forward-slash paths and sizes', () => {
    writeFileSync(join(dir, 'out.txt'), 'hello');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.json'), '{}');

    const files = collectProducedFiles(dir);
    expect(files).toEqual([
      { path: 'out.txt', size: 5 },
      { path: 'sub/nested.json', size: 2 },
    ]);
  });

  it('skips dot-prefixed scaffolding at every level', () => {
    mkdirSync(join(dir, '.ace-run'));
    writeFileSync(join(dir, '.ace-run', 'main.mjs'), 'code');
    mkdirSync(join(dir, '.ace-deny'));
    writeFileSync(join(dir, '.ace-deny', 'curl'), 'shim');
    writeFileSync(join(dir, 'real.txt'), 'x');

    expect(collectProducedFiles(dir)).toEqual([{ path: 'real.txt', size: 1 }]);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `f${i}.txt`), 'x');
    expect(collectProducedFiles(dir, 3)).toHaveLength(3);
  });

  it('returns nothing for a folder that is not there', () => {
    expect(collectProducedFiles(join(dir, 'missing'))).toEqual([]);
  });
});
