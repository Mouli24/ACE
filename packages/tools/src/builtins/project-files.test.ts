import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import {
  EDIT_FILE_DEFINITION,
  READ_FILE_DEFINITION,
  WRITE_FILE_DEFINITION,
  createEditFileTool,
  createListFilesTool,
  createReadFileTool,
  createWriteFileTool,
} from './project-files.js';

let root: string;
let project: string;
let cleanups: (() => void)[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-files-'));
  project = join(root, 'demo project');
  mkdirSync(join(project, 'src', 'deep'), { recursive: true });
  mkdirSync(join(project, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, 'src', 'math.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(join(project, 'src', 'deep', 'note.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(project, 'package.json'), '{}\n');
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

describe('FR-TOOL-008 list_files', () => {
  it('lists the project root, skipping .git and node_modules', async () => {
    expect(await createListFilesTool().implementation({}, ctx())).toEqual({
      entries: ['package.json', 'src/'],
      truncated: false,
    });
  });

  it('lists recursively, and stops at maxEntries', async () => {
    const all = (await createListFilesTool().implementation({ recursive: true }, ctx())) as { entries: string[] };
    expect(all.entries).toEqual(['package.json', 'src/', 'src/deep/', 'src/deep/note.txt', 'src/math.js']);
    expect(await createListFilesTool().implementation({ recursive: true, maxEntries: 2 }, ctx())).toEqual({
      entries: ['package.json', 'src/'],
      truncated: true,
    });
  });
});

describe('FR-TOOL-008 read_file', () => {
  it('reads a file under a folder with a space (review focus 4)', async () => {
    expect(await createReadFileTool().implementation({ path: 'src/math.js' }, ctx())).toMatchObject({
      path: 'src/math.js',
      content: 'export const add = (a, b) => a + b;\n',
      truncated: false,
    });
  });

  it('reads a window of lines', async () => {
    expect(
      await createReadFileTool().implementation({ path: 'src/deep/note.txt', offset: 2, limit: 1 }, ctx()),
    ).toMatchObject({ content: 'two', totalLines: 4 });
  });

  it('refuses a binary file and a missing one', async () => {
    writeFileSync(join(project, 'img.bin'), Buffer.from([0, 1, 2, 0]));
    await expect(createReadFileTool().implementation({ path: 'img.bin' }, ctx())).rejects.toThrow(/binary/);
    await expect(createReadFileTool().implementation({ path: 'nope.txt' }, ctx())).rejects.toThrow(/not a file/);
  });

  it('is not destructive', () => {
    expect(READ_FILE_DEFINITION.permissions.destructive).toBe(false);
  });
});

describe('FR-TOOL-008 write_file', () => {
  it('creates a file and its folders', async () => {
    expect(await createWriteFileTool().implementation({ path: 'src/new/util.js', content: 'x\n' }, ctx())).toEqual({
      path: 'src/new/util.js',
      bytes: 2,
      created: true,
    });
    expect(readFileSync(join(project, 'src', 'new', 'util.js'), 'utf8')).toBe('x\n');
  });

  it('TC-TOOL-009 refuses the parent folder, and logs the attempt', async () => {
    const context = ctx();
    await expect(createWriteFileTool().implementation({ path: '../outside.txt', content: 'x' }, context)).rejects.toThrow(
      /inside the project folder/,
    );
    expect(context.logger.lines.some((line) => line.level === 'warn')).toBe(true);
  });

  it('refuses .git', async () => {
    await expect(createWriteFileTool().implementation({ path: '.git/config', content: 'x' }, ctx())).rejects.toThrow(/\.git/);
    expect(WRITE_FILE_DEFINITION.permissions.destructive).toBe(false);
  });
});

describe('FR-TOOL-008 edit_file', () => {
  it('replaces exactly one match, taking $ literally', async () => {
    expect(
      await createEditFileTool().implementation(
        { path: 'src/math.js', oldString: 'a + b', newString: 'a + b; // $& stays' },
        ctx(),
      ),
    ).toEqual({ path: 'src/math.js', replacements: 1 });
    expect(readFileSync(join(project, 'src', 'math.js'), 'utf8')).toContain('a + b; // $& stays');
  });

  it('refuses no match, and an ambiguous one unless replaceAll', async () => {
    await expect(
      createEditFileTool().implementation({ path: 'src/math.js', oldString: 'nothing', newString: 'x' }, ctx()),
    ).rejects.toThrow(/not found/);
    writeFileSync(join(project, 'twice.txt'), 'a a');
    await expect(
      createEditFileTool().implementation({ path: 'twice.txt', oldString: 'a', newString: 'b' }, ctx()),
    ).rejects.toThrow(/matches 2 times/);
    expect(
      await createEditFileTool().implementation({ path: 'twice.txt', oldString: 'a', newString: 'b', replaceAll: true }, ctx()),
    ).toEqual({ path: 'twice.txt', replacements: 2 });
    expect(EDIT_FILE_DEFINITION.permissions.destructive).toBe(false);
  });
});

describe('the project tools without a project folder', () => {
  it('refuse instead of guessing a folder', async () => {
    const context = makeContext();
    cleanups.push(context.cleanup);
    await expect(createListFilesTool().implementation({}, context)).rejects.toThrow(/needs a project folder/);
  });
});
