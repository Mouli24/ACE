import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import { SEARCH_DEFINITION, createSearchTool } from './search-tool.js';

let root: string;
let project: string;
let cleanups: (() => void)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-search-'));
  project = join(root, 'demo project');
  mkdirSync(join(project, 'src', 'deep'), { recursive: true });
  mkdirSync(join(project, 'lib'), { recursive: true });
  mkdirSync(join(project, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(project, 'build'), { recursive: true });
  writeFileSync(join(project, '.gitignore'), 'build/\n');
  writeFileSync(join(project, 'src', 'math.ts'), 'export const add = 1;\nexport const sub = 2;\n');
  writeFileSync(join(project, 'src', 'deep', 'note.md'), 'add more notes\n');
  writeFileSync(join(project, 'lib', 'util.js'), 'const add = () => 0;\n');
  writeFileSync(join(project, 'node_modules', 'x', 'index.js'), 'add\n');
  writeFileSync(join(project, 'build', 'out.js'), 'add\n');
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  rmSync(root, { recursive: true, force: true });
});

const ctx = () => {
  const context = makeContext({ projectDir: project });
  cleanups.push(context.cleanup);
  return context;
};

interface SearchOutput {
  output: string;
  matches: number;
  truncated: boolean;
}
const search = async (args: Record<string, unknown>) =>
  (await createSearchTool().implementation(args, ctx())) as SearchOutput;

describe('FR-TOOL-008 search (agentic nodes workspace tools)', () => {
  it('answers `path:line: text`, skipping ignored files and node_modules', async () => {
    const result = await search({ pattern: 'add' });
    expect(result.output.split('\n').sort()).toEqual([
      'lib/util.js:1: const add = () => 0;',
      'src/deep/note.md:1: add more notes',
      'src/math.ts:1: export const add = 1;',
    ]);
    expect(result).toMatchObject({ matches: 3, truncated: false });
  });

  it('takes a regex', async () => {
    const result = await search({ pattern: 'export const (add|sub)' });
    expect(result.output.split('\n')).toEqual([
      'src/math.ts:1: export const add = 1;',
      'src/math.ts:2: export const sub = 2;',
    ]);
  });

  it('narrows to a folder, a file, and a glob', async () => {
    expect((await search({ pattern: 'add', path: 'src' })).output.split('\n').sort()).toEqual([
      'src/deep/note.md:1: add more notes',
      'src/math.ts:1: export const add = 1;',
    ]);
    expect((await search({ pattern: 'add', path: 'lib/util.js' })).output).toBe(
      'lib/util.js:1: const add = () => 0;',
    );
    expect((await search({ pattern: 'add', glob: '*.ts' })).output).toBe(
      'src/math.ts:1: export const add = 1;',
    );
    expect((await search({ pattern: 'add', path: 'src', glob: '*.md' })).output).toBe(
      'src/deep/note.md:1: add more notes',
    );
  });

  it('caps the matches and says so', async () => {
    writeFileSync(join(project, 'many.txt'), Array.from({ length: 50 }, () => 'hit').join('\n'));
    const capped = await search({ pattern: 'hit', maxResults: 10 });
    expect(capped.output.split('\n')).toHaveLength(10);
    expect(capped).toMatchObject({ matches: 10, truncated: true });
  });

  it('defaults to 200 matches', async () => {
    writeFileSync(join(project, 'many.txt'), Array.from({ length: 250 }, () => 'hit').join('\n'));
    const result = await search({ pattern: 'hit' });
    expect(result).toMatchObject({ matches: 200, truncated: true });
  });

  it('answers no matches with an empty output', async () => {
    expect(await search({ pattern: 'zzz-nothing' })).toMatchObject({
      output: '',
      matches: 0,
      truncated: false,
    });
  });

  it('refuses a bad regex and bad arguments as tool errors', async () => {
    await expect(search({ pattern: '(' })).rejects.toMatchObject({ kind: 'invalid_args' });
    await expect(search({})).rejects.toMatchObject({ kind: 'invalid_args' });
    await expect(search({ pattern: 'a', extra: 1 })).rejects.toMatchObject({
      kind: 'invalid_args',
    });
  });

  it('stays inside the project folder', async () => {
    await expect(search({ pattern: 'a', path: '..' })).rejects.toThrow(/escapes_sandbox/);
    await expect(search({ pattern: 'a', path: join(root, 'x') })).rejects.toThrow(/absolute_path/);
  });

  it('is non-destructive and confined to <project>', () => {
    expect(SEARCH_DEFINITION.name).toBe('search');
    expect(SEARCH_DEFINITION.permissions).toMatchObject({
      destructive: false,
      network: false,
      fsPaths: ['<project>'],
    });
  });

  it('refuses without a project folder', async () => {
    const context = makeContext();
    cleanups.push(context.cleanup);
    await expect(createSearchTool().implementation({ pattern: 'a' }, context)).rejects.toThrow(
      /needs a project folder/,
    );
  });
});
