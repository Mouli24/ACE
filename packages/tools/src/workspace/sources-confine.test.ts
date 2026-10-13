import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { WorkspaceFsError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as resolveModule from './resolve.js';
import type * as ResolveModule from './resolve.js';
import { readSources } from './sources.js';

vi.mock('./resolve.js', async (importOriginal) => {
  const original = await importOriginal<typeof ResolveModule>();
  return { ...original, toAbsolute: vi.fn(original.toAbsolute) };
});

/** A file symlink needs a privilege on Windows; without it the real-link test is skipped. */
const canFileSymlink = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-link-probe-'));
  try {
    writeFileSync(join(dir, 't'), '');
    symlinkSync(join(dir, 't'), join(dir, 'l'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let outside: string;
let root: string;

function put(path: string, content: string): void {
  const absolute = join(root, ...path.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

beforeEach(async () => {
  outside = mkdtempSync(join(tmpdir(), 'ace-sources-out-'));
  root = join(outside, 'project');
  mkdirSync(root);
  const actual = await vi.importActual<typeof ResolveModule>('./resolve.js');
  vi.mocked(resolveModule.toAbsolute).mockImplementation(actual.toAbsolute);
});
afterEach(() => {
  rmSync(outside, { recursive: true, force: true });
});

describe('D299 Phase 4 fix I1: sources are read only through the file API’s confinement', () => {
  it('reads every source and the tsconfig through toAbsolute, and leaves out what it refuses', async () => {
    put('a.ts', 'export const a = 1;');
    put('b.ts', 'export const b = 2;');
    put('tsconfig.json', '{}');
    const actual = await vi.importActual<typeof ResolveModule>('./resolve.js');
    vi.mocked(resolveModule.toAbsolute).mockImplementation((base, rel, options) => {
      if (rel === 'b.ts' || rel === 'tsconfig.json') {
        throw new WorkspaceFsError('outside_project', 'That path is outside the project folder.');
      }
      return actual.toAbsolute(base, rel, options);
    });

    const result = await readSources(root);
    expect(result.files.map((file) => file.path)).toEqual(['a.ts']);
    expect(result).not.toHaveProperty('tsconfig');
    expect(resolveModule.toAbsolute).toHaveBeenCalledWith(expect.any(String), 'tsconfig.json');
  });

  it.skipIf(!canFileSymlink)(
    'never returns a tsconfig.json that links out of the project',
    async () => {
      writeFileSync(join(outside, 'credentials'), '{ "secret": "do-not-serve" }');
      symlinkSync(join(outside, 'credentials'), join(root, 'tsconfig.json'), 'file');
      put('a.ts', 'export {};');
      const result = await readSources(root);
      expect(result).not.toHaveProperty('tsconfig');
      expect(result.files.map((file) => file.path)).toEqual(['a.ts']);
    },
  );
});
