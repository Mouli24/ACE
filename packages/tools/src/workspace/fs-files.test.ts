import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FILE_EDIT_MAX_BYTES } from '@ace/contracts';
import { isWorkspaceFsError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createEntry,
  listAllFiles,
  listFolder,
  moveEntry,
  readFile,
  readRaw,
  removeEntry,
  versionOf,
  writeFile,
} from './fs-files.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

let root: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-forge-'));
  project = join(root, 'My Project');
  mkdirSync(project);
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));

const put = (rel: string, content: string | Buffer = '') => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), content);
};
const disk = (rel: string) => readFileSync(join(project, rel));

/** The refusal's code and details; fails when the promise resolves or throws something else. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (isWorkspaceFsError(error)) {
      return error.details === undefined
        ? { code: error.code }
        : { code: error.code, details: error.details };
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

const save = (path: string, content: string, baseVersion: string | null) =>
  writeFile(project, { path, content, baseVersion, eol: 'lf', bom: false });

describe('FR-GIT-003 listing a folder', () => {
  it('lists one level, folders first in natural order, hides .git and dims ignored entries', async () => {
    put('b.txt', 'b');
    put('a10.txt');
    put('a2.txt');
    put('src/index.ts');
    put('.git/HEAD', 'ref: refs/heads/main');
    put('node_modules/x/index.js');
    put('.gitignore', '*.log\n');
    put('debug.log');

    const listing = await listFolder(project, '');

    expect(listing.path).toBe('');
    expect(listing.items.map((entry) => entry.name)).toEqual([
      'node_modules',
      'src',
      '.gitignore',
      'a2.txt',
      'a10.txt',
      'b.txt',
      'debug.log',
    ]);
    expect(listing.items.find((e) => e.name === 'node_modules')?.ignored).toBe(true);
    expect(listing.items.find((e) => e.name === 'debug.log')?.ignored).toBe(true);
    expect(listing.items.find((e) => e.name === 'src')).toMatchObject({
      path: 'src',
      kind: 'folder',
      size: 0,
      ignored: false,
    });
    expect(listing.items.find((e) => e.name === 'b.txt')).toMatchObject({ path: 'b.txt', size: 1 });
  });

  it('lists a nested folder with project-relative paths and honours its .gitignore', async () => {
    put('src/keep.ts');
    put('src/gen/out.js');
    put('src/.gitignore', 'gen/\n');

    const listing = await listFolder(project, 'src');

    expect(listing.path).toBe('src');
    expect(listing.items.map((e) => [e.path, e.ignored])).toEqual([
      ['src/gen', true],
      ['src/.gitignore', false],
      ['src/keep.ts', false],
    ]);
  });

  it('answers not_found for a missing folder and invalid_path for a file', async () => {
    put('a.txt');
    expect((await refusal(listFolder(project, 'nope'))).code).toBe('not_found');
    expect((await refusal(listFolder(project, 'a.txt'))).code).toBe('invalid_path');
  });
});

describe('FR-GIT-008 every path stays inside the project', () => {
  it.each([
    ['../x'],
    ['src/../../x'],
    ['C:\\Windows\\win.ini'],
    ['/etc/passwd'],
    ['\\\\host\\share\\x'],
    ['a\u0000b'],
    ['~/secret'],
  ])('refuses to read %j as outside_project', async (path) => {
    expect((await refusal(readFile(project, path))).code).toBe('outside_project');
  });

  it.each([
    '.git/config',
    '.GIT/config',
    '.git./hooks/pre-commit',
    'sub/.git/config',
    'deep/er/.Git /HEAD',
    '.ace/state.json',
    'x/.ace/y',
  ])('refuses to write %j inside a protected folder', async (path) => {
    expect((await refusal(save(path, 'x', null))).code).toBe('protected_path');
    expect((await refusal(createEntry(project, { path, kind: 'file' }))).code).toBe(
      'protected_path',
    );
  });

  it.each(['CON', 'aux.txt', 'nul.md', 'trailing.', 'trailing ', 'a<b', 'a|b', 'q?.txt'])(
    'refuses to create the name %j',
    async (name) => {
      expect((await refusal(createEntry(project, { path: name, kind: 'file' }))).code).toMatch(
        /^(invalid_path|outside_project)$/,
      );
    },
  );

  it('refuses the project folder itself where an entry is needed', async () => {
    expect((await refusal(removeEntry(project, ''))).code).toBe('invalid_path');
    expect((await refusal(removeEntry(project, '.'))).code).toBe('invalid_path');
    expect((await refusal(readFile(project, './'))).code).toBe('invalid_path');
  });

  it('works with spaces, unicode and leading dots', async () => {
    const created = await createEntry(project, { path: 'My Notes/ü.md', kind: 'file' });
    expect(created).toMatchObject({ path: 'My Notes/ü.md', name: 'ü.md', kind: 'file' });
    await createEntry(project, { path: '.env', kind: 'file' });
    expect((await listFolder(project, 'My Notes')).items.map((e) => e.path)).toEqual([
      'My Notes/ü.md',
    ]);
    expect((await readFile(project, '.env')).kind).toBe('text');
  });

  it('neither lists nor reads through a link that points outside the project', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    // a junction needs no privilege on Windows; elsewhere the type argument is ignored
    symlinkSync(outside, join(project, 'out'), 'junction');

    expect((await listFolder(project, '')).items.map((e) => e.name)).not.toContain('out');
    expect((await refusal(readFile(project, 'out/secret.txt'))).code).toBe('outside_project');
  });
});

describe('FR-GIT-004 reading a file', () => {
  it('reads UTF-8 text with its version, line ending and BOM', async () => {
    put('a.txt', Buffer.concat([BOM, Buffer.from('one\r\ntwo\r\n')]));

    expect(await readFile(project, 'a.txt')).toEqual({
      kind: 'text',
      path: 'a.txt',
      content: 'one\r\ntwo\r\n',
      version: versionOf(disk('a.txt')),
      eol: 'crlf',
      bom: true,
      size: 13,
    });
  });

  it('treats a file with a NUL byte as binary', async () => {
    put('img.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    expect(await readFile(project, 'img.bin')).toEqual({
      kind: 'binary',
      path: 'img.bin',
      size: 4,
    });
  });

  it('treats a file that is not UTF-8 as binary', async () => {
    put('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect((await readFile(project, 'latin1.txt')).kind).toBe('binary');
  });

  it('describes a file over the editable limit without sending it', async () => {
    put('big.log', Buffer.alloc(FILE_EDIT_MAX_BYTES + 1, 0x61));
    expect(await readFile(project, 'big.log')).toEqual({
      kind: 'too_large',
      path: 'big.log',
      size: FILE_EDIT_MAX_BYTES + 1,
    });
  });

  it('answers not_found for a missing file and for a folder', async () => {
    put('src/a.ts');
    expect((await refusal(readFile(project, 'nope.ts'))).code).toBe('not_found');
    expect((await refusal(readFile(project, 'src'))).code).toBe('not_found');
  });
});

describe('FR-GIT-004 saving a file', () => {
  it('round-trips a CRLF file with a BOM byte for byte', async () => {
    const original = Buffer.concat([BOM, Buffer.from('a\r\nb\r\n')]);
    put('x.txt', original);
    const read = await readFile(project, 'x.txt');
    if (read.kind !== 'text') throw new Error('expected text');

    const saved = await writeFile(project, {
      path: 'x.txt',
      content: read.content,
      baseVersion: read.version,
      eol: read.eol,
      bom: read.bom,
    });

    expect(disk('x.txt').equals(original)).toBe(true);
    expect(saved).toMatchObject({ path: 'x.txt', version: read.version, size: original.length });
  });

  it('writes the line endings it is given', async () => {
    put('x.txt', 'old');
    await writeFile(project, {
      path: 'x.txt',
      content: 'a\nb\r\nc',
      baseVersion: versionOf(Buffer.from('old')),
      eol: 'crlf',
      bom: false,
    });
    expect(disk('x.txt').toString()).toBe('a\r\nb\r\nc');
  });

  it('refuses a save whose base version is stale, naming what is on disk', async () => {
    put('a.txt', 'one');
    const loaded = versionOf(Buffer.from('one'));
    put('a.txt', 'two');

    expect(await refusal(save('a.txt', 'mine', loaded))).toEqual({
      code: 'file_changed',
      details: { currentVersion: versionOf(Buffer.from('two')) },
    });
    expect(disk('a.txt').toString()).toBe('two');
  });

  it('recreates a deleted file with a null base, and refuses null while the file exists', async () => {
    expect((await save('again.txt', 'back', null)).path).toBe('again.txt');
    expect(disk('again.txt').toString()).toBe('back');
    expect(await refusal(save('again.txt', 'x', null))).toEqual({
      code: 'file_changed',
      details: { currentVersion: versionOf(Buffer.from('back')) },
    });
  });

  it('answers a stale save of a deleted file with currentVersion null', async () => {
    expect(await refusal(save('gone.txt', 'x', 'v1'))).toEqual({
      code: 'file_changed',
      details: { currentVersion: null },
    });
  });

  it('refuses a save over 2 MB', async () => {
    expect((await refusal(save('big.txt', 'a'.repeat(FILE_EDIT_MAX_BYTES + 1), null))).code).toBe(
      'file_too_large',
    );
  });

  it('answers not_found when the folder is gone, and leaves no temporary file behind', async () => {
    expect((await refusal(save('gone/a.txt', 'x', null))).code).toBe('not_found');
    put('a.txt', 'one');
    await save('a.txt', 'two', versionOf(Buffer.from('one')));
    expect(readdirSync(project).filter((name) => name.endsWith('.ace-save'))).toEqual([]);
  });
});

describe('FR-GIT-003 creating, moving and deleting', () => {
  it('creates a file with its missing folders, and a folder', async () => {
    expect(await createEntry(project, { path: 'a/b/c.ts', kind: 'file' })).toMatchObject({
      path: 'a/b/c.ts',
      kind: 'file',
      size: 0,
    });
    expect(await createEntry(project, { path: 'docs', kind: 'folder' })).toMatchObject({
      path: 'docs',
      kind: 'folder',
    });
    expect(disk('a/b/c.ts').length).toBe(0);
  });

  it('refuses to create over an existing entry', async () => {
    put('a.txt', 'keep');
    expect((await refusal(createEntry(project, { path: 'a.txt', kind: 'file' }))).code).toBe(
      'exists',
    );
    expect(disk('a.txt').toString()).toBe('keep');
  });

  it('moves a file into another folder, creating it, and renames a folder', async () => {
    put('a.txt', 'x');
    put('lib/u.ts', 'u');
    expect((await moveEntry(project, 'a.txt', 'docs/a.txt')).path).toBe('docs/a.txt');
    expect(disk('docs/a.txt').toString()).toBe('x');
    expect((await moveEntry(project, 'lib', 'src')).kind).toBe('folder');
    expect(disk('src/u.ts').toString()).toBe('u');
  });

  it('renames a file to another case of its own name', async () => {
    put('readme.md', 'x');
    expect((await moveEntry(project, 'readme.md', 'README.md')).path).toBe('README.md');
    expect(readdirSync(project)).toContain('README.md');
    expect(readdirSync(project)).not.toContain('readme.md');
  });

  it('refuses to move onto an existing entry, or a folder into itself', async () => {
    put('a.txt', 'a');
    put('b.txt', 'b');
    put('src/x.ts');
    expect((await refusal(moveEntry(project, 'a.txt', 'b.txt'))).code).toBe('exists');
    expect((await refusal(moveEntry(project, 'src', 'src/inner'))).code).toBe('invalid_path');
    expect((await refusal(moveEntry(project, 'nope', 'x'))).code).toBe('not_found');
    expect(disk('b.txt').toString()).toBe('b');
  });

  it('deletes a file and a folder with its contents', async () => {
    put('a.txt');
    put('src/deep/x.ts');
    await removeEntry(project, 'a.txt');
    await removeEntry(project, 'src');
    expect(readdirSync(project)).toEqual([]);
    expect((await refusal(removeEntry(project, 'a.txt'))).code).toBe('not_found');
  });

  it('refuses to move or delete inside .git', async () => {
    put('.git/config', '[core]');
    expect((await refusal(removeEntry(project, '.git/config'))).code).toBe('protected_path');
    expect((await refusal(moveEntry(project, '.git/config', 'config'))).code).toBe(
      'protected_path',
    );
  });
});

describe('quick open: every file in the project', () => {
  it('lists files breadth first, skipping hidden and ignored folders and ignored files', async () => {
    put('a.ts');
    put('src/b.ts');
    put('src/deep/c.ts');
    put('node_modules/x.js');
    put('.git/HEAD');
    put('dist/out.js');
    put('.gitignore', '*.log\n');
    put('notes.log');

    expect(await listAllFiles(project)).toEqual({
      files: ['.gitignore', 'a.ts', 'src/b.ts', 'src/deep/c.ts'],
      truncated: false,
    });
  });

  it('list skips ignored folders and stops at the cap', async () => {
    put('a.ts');
    put('b.ts');
    put('c.ts');
    put('node_modules/z.js');
    expect(await listAllFiles(project, 2)).toEqual({ files: ['a.ts', 'b.ts'], truncated: true });
  });
});

describe('D299 image previews', () => {
  it('serves the bytes with an image type, or a generic type', async () => {
    put('a.png', Buffer.from([1, 2, 3]));
    put('logo.SVG', '<svg/>');
    put('a.bin', Buffer.from([0]));
    const png = await readRaw(project, 'a.png');
    expect(png.contentType).toBe('image/png');
    expect([...new Uint8Array(png.bytes)]).toEqual([1, 2, 3]);
    expect((await readRaw(project, 'logo.SVG')).contentType).toBe('image/svg+xml');
    expect((await readRaw(project, 'a.bin')).contentType).toBe('application/octet-stream');
  });

  it('refuses a file over the preview limit', async () => {
    put('big.png', Buffer.alloc(5));
    expect((await refusal(readRaw(project, 'big.png', 4))).code).toBe('file_too_large');
  });
});
