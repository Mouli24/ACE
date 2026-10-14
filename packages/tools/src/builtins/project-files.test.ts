import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeContext } from '../__tests__/helpers.js';
import { createReadLedger } from '../agent/ledger.js';
import { createPathLocks } from '../agent/locks.js';
import { type AgentSession } from '../agent/session.js';
import { ToolError } from '../errors.js';
import { type ToolContext } from '../tool.js';
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
    const all = (await createListFilesTool().implementation({ recursive: true }, ctx())) as {
      entries: string[];
    };
    expect(all.entries).toEqual([
      'package.json',
      'src/',
      'src/deep/',
      'src/deep/note.txt',
      'src/math.js',
    ]);
    expect(
      await createListFilesTool().implementation({ recursive: true, maxEntries: 2 }, ctx()),
    ).toEqual({
      entries: ['package.json', 'src/'],
      truncated: true,
    });
  });
});

describe('FR-TOOL-008 read_file', () => {
  it('reads a file under a folder with a space (review focus 4)', async () => {
    expect(await createReadFileTool().implementation({ path: 'src/math.js' }, ctx())).toMatchObject(
      {
        path: 'src/math.js',
        content: 'export const add = (a, b) => a + b;\n',
        truncated: false,
      },
    );
  });

  it('reads a window of lines', async () => {
    expect(
      await createReadFileTool().implementation(
        { path: 'src/deep/note.txt', offset: 2, limit: 1 },
        ctx(),
      ),
    ).toMatchObject({ content: 'two', totalLines: 4 });
  });

  it('refuses a binary file and a missing one', async () => {
    writeFileSync(join(project, 'img.bin'), Buffer.from([0, 1, 2, 0]));
    await expect(createReadFileTool().implementation({ path: 'img.bin' }, ctx())).rejects.toThrow(
      /binary/,
    );
    await expect(createReadFileTool().implementation({ path: 'nope.txt' }, ctx())).rejects.toThrow(
      /not a file/,
    );
  });

  it('is not destructive', () => {
    expect(READ_FILE_DEFINITION.permissions.destructive).toBe(false);
  });
});

describe('FR-TOOL-008 write_file', () => {
  it('creates a file and its folders', async () => {
    expect(
      await createWriteFileTool().implementation(
        { path: 'src/new/util.js', content: 'x\n' },
        ctx(),
      ),
    ).toEqual({
      path: 'src/new/util.js',
      bytes: 2,
      created: true,
    });
    expect(readFileSync(join(project, 'src', 'new', 'util.js'), 'utf8')).toBe('x\n');
  });

  it('TC-TOOL-009 refuses the parent folder, and logs the attempt', async () => {
    const context = ctx();
    await expect(
      createWriteFileTool().implementation({ path: '../outside.txt', content: 'x' }, context),
    ).rejects.toThrow(/inside the project folder/);
    expect(context.logger.lines.some((line) => line.level === 'warn')).toBe(true);
  });

  it('refuses .git', async () => {
    await expect(
      createWriteFileTool().implementation({ path: '.git/config', content: 'x' }, ctx()),
    ).rejects.toThrow(/\.git/);
    // Windows and macOS fold case: .GIT is the same folder (review C1).
    await expect(
      createWriteFileTool().implementation({ path: '.GIT/config', content: 'x' }, ctx()),
    ).rejects.toThrow(/\.git/);
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
      createEditFileTool().implementation(
        { path: 'src/math.js', oldString: 'nothing', newString: 'x' },
        ctx(),
      ),
    ).rejects.toThrow(/not found/);
    writeFileSync(join(project, 'twice.txt'), 'a a');
    await expect(
      createEditFileTool().implementation(
        { path: 'twice.txt', oldString: 'a', newString: 'b' },
        ctx(),
      ),
    ).rejects.toThrow(/matches 2 times/);
    expect(
      await createEditFileTool().implementation(
        { path: 'twice.txt', oldString: 'a', newString: 'b', replaceAll: true },
        ctx(),
      ),
    ).toEqual({ path: 'twice.txt', replacements: 2 });
    expect(EDIT_FILE_DEFINITION.permissions.destructive).toBe(false);
  });
});

/* ------------------------------------------- agentic nodes: one session per run, shared by nodes */

const newSession = (): AgentSession => ({
  ledger: createReadLedger(),
  locks: createPathLocks(),
  processes: {
    start: () => ({ processId: 'p' }),
    output: () => undefined,
    kill: async () => false,
    killAll: async () => undefined,
  },
});

const nodeCtx = (session: AgentSession, nodeId: string) => {
  const context = makeContext({ projectDir: project, session, nodeId });
  cleanups.push(context.cleanup);
  return context;
};

const read = (context: ToolContext, path: string) =>
  createReadFileTool().implementation({ path }, context);
const write = (context: ToolContext, path: string, content: string) =>
  createWriteFileTool().implementation({ path, content }, context);
const edit = (context: ToolContext, path: string, oldString: string, newString: string) =>
  createEditFileTool().implementation({ path, oldString, newString }, context);
const onDisk = (path: string) => readFileSync(join(project, path), 'utf8');

describe('FR-TOOL-008 read-before-edit (agentic nodes)', () => {
  it('refuses to overwrite or edit a file the node never read, and says to read it', async () => {
    const a = nodeCtx(newSession(), 'A');
    await expect(write(a, 'src/math.js', 'x')).rejects.toThrow(/has not read .*read_file/);
    await expect(edit(a, 'src/math.js', 'a + b', 'a - b')).rejects.toThrow(
      /has not read .*read_file/,
    );
    expect(onDisk('src/math.js')).toBe('export const add = (a, b) => a + b;\n');
  });

  it('allows the edit after a read, and a second edit of its own change without re-reading', async () => {
    const a = nodeCtx(newSession(), 'A');
    await read(a, 'src/math.js');
    await edit(a, 'src/math.js', 'a + b', 'a - b');
    await edit(a, 'src/math.js', 'a - b', 'a * b');
    await write(a, 'src/math.js', 'replaced\n');
    expect(onDisk('src/math.js')).toBe('replaced\n');
  });

  it('creates a new file without a read, then edits it without one', async () => {
    const a = nodeCtx(newSession(), 'A');
    await write(a, 'src/fresh.ts', 'let n = 1;\n');
    await edit(a, 'src/fresh.ts', 'n = 1', 'n = 2');
    expect(onDisk('src/fresh.ts')).toBe('let n = 2;\n');
  });

  it('refuses an edit after another node changed the file, until it reads again', async () => {
    const session = newSession();
    const a = nodeCtx(session, 'A');
    const b = nodeCtx(session, 'B');
    await read(a, 'src/math.js');
    await read(b, 'src/math.js');
    await edit(a, 'src/math.js', 'a + b', 'a - b');
    await expect(edit(b, 'src/math.js', 'a - b', 'a / b')).rejects.toThrow(
      /changed since .*read.*read_file/,
    );
    await expect(write(b, 'src/math.js', 'clobber')).rejects.toThrow(/changed since/);
    expect(onDisk('src/math.js')).toContain('a - b');
    await read(b, 'src/math.js');
    await edit(b, 'src/math.js', 'a - b', 'a / b');
    expect(onDisk('src/math.js')).toContain('a / b');
  });

  it('refuses an edit after the file changed on disk outside the tools (a command, the person)', async () => {
    const a = nodeCtx(newSession(), 'A');
    await read(a, 'src/math.js');
    writeFileSync(join(project, 'src', 'math.js'), 'export const add = (a, b) => b + a;\n');
    await expect(edit(a, 'src/math.js', 'b + a', 'a + b')).rejects.toThrow(/changed since/);
  });

  it('carries the reason in the error details', async () => {
    const a = nodeCtx(newSession(), 'A');
    const caught = await write(a, 'src/math.js', 'x').catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ToolError);
    expect(caught).toMatchObject({ kind: 'invalid_args', details: { reason: 'not_read' } });
    await read(a, 'src/math.js');
    writeFileSync(join(project, 'src', 'math.js'), 'other');
    const again = await write(a, 'src/math.js', 'x').catch((error: unknown) => error);
    expect(again).toMatchObject({ details: { reason: 'changed_since_read' } });
  });

  it('serializes concurrent writes to one path: the second sees the first and is refused', async () => {
    const session = newSession();
    const a = nodeCtx(session, 'A');
    const b = nodeCtx(session, 'B');
    const results = await Promise.allSettled([
      write(a, 'src/race.ts', 'from A\n'),
      write(b, 'src/race.ts', 'from B\n'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(['from A\n', 'from B\n']).toContain(onDisk('src/race.ts'));
  });

  it('holds the path lock while it writes and edits', async () => {
    const session = newSession();
    const held: string[] = [];
    const locks = session.locks;
    const spied: AgentSession = {
      ...session,
      locks: {
        withLock: (path, fn) => {
          held.push(path);
          return locks.withLock(path, fn);
        },
      },
    };
    const a = nodeCtx(spied, 'A');
    await write(a, 'src/locked.ts', 'one\n');
    await edit(a, 'src/locked.ts', 'one', 'two');
    expect(held).toEqual([join(project, 'src', 'locked.ts'), join(project, 'src', 'locked.ts')]);
  });

  it('without a session (chat turns), behaves as before: no read needed', async () => {
    await write(ctx(), 'src/math.js', 'plain\n');
    await edit(ctx(), 'src/math.js', 'plain', 'still plain');
    expect(onDisk('src/math.js')).toBe('still plain\n');
  });
});

describe('FR-TOOL-008 edit_file match counts and line endings', () => {
  it('says how many times oldString matched: 0 or 2', async () => {
    const a = nodeCtx(newSession(), 'A');
    writeFileSync(join(project, 'twice.txt'), 'a a');
    await read(a, 'twice.txt');
    await expect(edit(a, 'twice.txt', 'zzz', 'y')).rejects.toThrow(/found 0 times/);
    await expect(edit(a, 'twice.txt', 'a', 'b')).rejects.toThrow(/matches 2 times/);
  });

  it('keeps a CRLF file CRLF when oldString/newString use \\n', async () => {
    const a = nodeCtx(newSession(), 'A');
    writeFileSync(join(project, 'win.txt'), 'one\r\ntwo\r\nthree\r\n');
    await read(a, 'win.txt');
    await edit(a, 'win.txt', 'one\ntwo', 'uno\ndos\ndos-bis');
    expect(onDisk('win.txt')).toBe('uno\r\ndos\r\ndos-bis\r\nthree\r\n');
    // Already-CRLF arguments are not doubled.
    await edit(a, 'win.txt', 'dos-bis\r\nthree', 'tres\r\nfour');
    expect(onDisk('win.txt')).toBe('uno\r\ndos\r\ntres\r\nfour\r\n');
  });

  it('leaves an LF file LF', async () => {
    const a = nodeCtx(newSession(), 'A');
    await read(a, 'src/deep/note.txt');
    await edit(a, 'src/deep/note.txt', 'one\ntwo', '1\n2');
    expect(onDisk('src/deep/note.txt')).toBe('1\n2\nthree\n');
  });
});

describe('FR-TOOL-008 read_file for agentic nodes', () => {
  it('answers a binary file with a notice, not an error', async () => {
    writeFileSync(join(project, 'img.bin'), Buffer.from([0, 1, 2, 0]));
    const result = await read(nodeCtx(newSession(), 'A'), 'img.bin');
    expect(result).toMatchObject({ path: 'img.bin', binary: true, content: '' });
    expect(result).toHaveProperty('notice', expect.stringMatching(/binary/));
  });

  it('shows at most 2000 lines by default, and cuts lines over 2000 characters', async () => {
    const long = 'x'.repeat(2500);
    const lines = [long, ...Array.from({ length: 2999 }, (_, i) => `line ${i + 2}`)];
    writeFileSync(join(project, 'big.txt'), lines.join('\n'));
    const result = (await read(nodeCtx(newSession(), 'A'), 'big.txt')) as {
      content: string;
      totalLines: number;
      truncated: boolean;
    };
    const shown = result.content.split('\n');
    expect(shown).toHaveLength(2000);
    expect(shown[0]).toHaveLength(2000 + '… [line truncated]'.length);
    expect(shown[1999]).toBe('line 2000');
    expect(result.totalLines).toBe(3000);
    expect(result.truncated).toBe(true);
  });

  it('records the whole file, so a windowed read still allows the edit', async () => {
    const a = nodeCtx(newSession(), 'A');
    await createReadFileTool().implementation(
      { path: 'src/deep/note.txt', offset: 3, limit: 1 },
      a,
    );
    await edit(a, 'src/deep/note.txt', 'one', 'ONE');
    expect(onDisk('src/deep/note.txt')).toBe('ONE\ntwo\nthree\n');
  });
});

describe('FR-TOOL-008 path guard through the file tools', () => {
  it('refuses to read or write through a junction that points out of the project', async () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(project, 'out'), 'junction');
    const a = nodeCtx(newSession(), 'A');
    await expect(read(a, 'out/secret.txt')).rejects.toThrow(/symlink_escape/);
    await expect(write(a, 'out/new.txt', 'x')).rejects.toThrow(/symlink_escape/);
    await expect(write(ctx(), 'out/new.txt', 'x')).rejects.toThrow(/symlink_escape/);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('refuses `..` and an absolute path', async () => {
    const a = nodeCtx(newSession(), 'A');
    await expect(read(a, '../outside.txt')).rejects.toThrow(/escapes_sandbox/);
    await expect(read(a, join(root, 'x.txt'))).rejects.toThrow(/absolute_path/);
  });

  it('refuses a write into .git with a session too', async () => {
    const a = nodeCtx(newSession(), 'A');
    await expect(write(a, '.git/config', 'x')).rejects.toThrow(/may not write inside \.git/);
  });

  it.runIf(process.platform === 'win32')(
    'refuses UNC, an alternate data stream, NUL and con.txt on Windows',
    async () => {
      const a = nodeCtx(newSession(), 'A');
      await expect(read(a, '\\\\server\\share\\x.txt')).rejects.toThrow(/absolute_path/);
      await expect(write(a, 'file.txt:hidden', 'x')).rejects.toThrow(/alternate_data_stream/);
      await expect(write(a, 'NUL', 'x')).rejects.toThrow(/reserved_device_name/);
      await expect(write(a, 'src/con.txt', 'x')).rejects.toThrow(/reserved_device_name/);
      expect(existsSync(join(project, 'file.txt'))).toBe(false);
    },
  );
});

describe('the project tools without a project folder', () => {
  it('refuse instead of guessing a folder', async () => {
    const context = makeContext();
    cleanups.push(context.cleanup);
    await expect(createListFilesTool().implementation({}, context)).rejects.toThrow(
      /needs a project folder/,
    );
  });
});
