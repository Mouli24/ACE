import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSources } from './sources.js';

let root: string;

function put(path: string, content: string | Buffer): void {
  const absolute = join(root, ...path.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-sources-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('D299 Phase 4 readSources', () => {
  it('reads every TS and JS source, shallowest first and then by name', async () => {
    put('src/z.ts', 'z');
    put('src/a/deep.tsx', 'deep');
    put('b.mts', 'b');
    put('a.js', 'a');
    put('src/types.d.ts', 'declare const x: number;');
    put('src/c.cts', 'c');
    put('src/d.jsx', 'd');
    put('src/e.mjs', 'e');
    put('src/f.cjs', 'f');
    put('README.md', '# no');
    put('styles.css', 'no');
    put('package.json', '{}');
    const result = await readSources(root);
    expect(result.files.map((file) => file.path)).toEqual([
      'a.js',
      'b.mts',
      'src/c.cts',
      'src/d.jsx',
      'src/e.mjs',
      'src/f.cjs',
      'src/types.d.ts',
      'src/z.ts',
      'src/a/deep.tsx',
    ]);
    expect(result.files.find((file) => file.path === 'src/types.d.ts')?.content).toBe(
      'declare const x: number;',
    );
    expect(result.truncated).toBe(false);
  });

  it('never reads node_modules, the default folders or a .gitignore match, nor a binary file', async () => {
    put('src/a.ts', 'a');
    put('node_modules/pkg/index.d.ts', 'x');
    put('packages/x/node_modules/y/i.js', 'x');
    put('dist/out.js', 'x');
    put('generated/g.ts', 'x');
    put('.gitignore', 'generated/\n');
    put('src/bin.js', Buffer.from([0x61, 0x00, 0x62]));
    const result = await readSources(root);
    expect(result.files.map((file) => file.path)).toEqual(['src/a.ts']);
  });

  it('stops at maxFiles and says it was truncated', async () => {
    put('a.ts', 'a');
    put('b.ts', 'b');
    put('c.ts', 'c');
    const cut = await readSources(root, { maxFiles: 2 });
    expect(cut.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(cut.truncated).toBe(true);
    const exact = await readSources(root, { maxFiles: 3 });
    expect(exact.truncated).toBe(false);
  });

  it('stops at maxBytes, counting UTF-8 bytes, and says it was truncated', async () => {
    put('a.ts', 'x'.repeat(10));
    put('b.ts', 'é'.repeat(5));
    put('c.ts', 'y'.repeat(10));
    const result = await readSources(root, { maxBytes: 25 });
    expect(result.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts']);
    expect(result.truncated).toBe(true);
  });

  it('takes only the extensions asked for', async () => {
    put('a.ts', 'a');
    put('b.js', 'b');
    const result = await readSources(root, { exts: ['js'] });
    expect(result.files.map((file) => file.path)).toEqual(['b.js']);
  });

  it('carries the root tsconfig.json as text when there is one', async () => {
    put('a.ts', 'a');
    expect(await readSources(root)).not.toHaveProperty('tsconfig');
    put('tsconfig.json', '{ "compilerOptions": { "baseUrl": "." } }');
    expect((await readSources(root)).tsconfig).toBe('{ "compilerOptions": { "baseUrl": "." } }');
  });
});
