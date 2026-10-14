import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../errors.js';
import { RecordingToolLogger, SANDBOX_DENIED_MESSAGE } from '../logging.js';
import {
  PATH_REFUSAL_REASONS,
  assertInsideSandbox,
  resolveInsideSandbox,
  sandboxDirFor,
} from './paths.js';

let projectFolder: string;
let sandboxDir: string;

beforeEach(() => {
  projectFolder = mkdtempSync(join(tmpdir(), 'ace-paths-'));
  sandboxDir = sandboxDirFor(projectFolder, '01J9ZS0ABCDEFGHJKMNPQRSTVW');
  mkdirSync(sandboxDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectFolder, { recursive: true, force: true, maxRetries: 100, retryDelay: 50 });
});

describe('FR-TOOL-004 sandbox folder', () => {
  it('is `<projectFolder>/.ace/sandbox/<runId>/`', () => {
    expect(sandboxDirFor('/home/me/project', 'run1')).toBe(
      resolve('/home/me/project', '.ace', 'sandbox', 'run1'),
    );
  });

  it('refuses a run id that would climb out of the sandbox root', () => {
    expect(() => sandboxDirFor('/home/me/project', '../../etc')).toThrow(ToolError);
    expect(() => sandboxDirFor('/home/me/project', '')).toThrow(ToolError);
  });
});

describe('TC-GRD-006 Path confinement', () => {
  it('accepts a plain relative path inside the sandbox', () => {
    const result = resolveInsideSandbox(sandboxDir, 'notes.txt');
    expect(result).toEqual({ ok: true, path: join(sandboxDir, 'notes.txt') });
  });

  it('accepts a nested path and a `./` prefix', () => {
    expect(resolveInsideSandbox(sandboxDir, './a/b/c.txt')).toEqual({
      ok: true,
      path: join(sandboxDir, 'a', 'b', 'c.txt'),
    });
  });

  it('accepts a path that climbs and comes back inside', () => {
    expect(resolveInsideSandbox(sandboxDir, 'a/../b.txt')).toEqual({
      ok: true,
      path: join(sandboxDir, 'b.txt'),
    });
  });

  it('refuses `../../x`', () => {
    expect(resolveInsideSandbox(sandboxDir, '../../x')).toEqual({
      ok: false,
      reason: 'escapes_sandbox',
      requested: '../../x',
    });
  });

  it('refuses a single `..`', () => {
    expect(resolveInsideSandbox(sandboxDir, '..')).toMatchObject({
      ok: false,
      reason: 'escapes_sandbox',
    });
  });

  it('refuses an absolute path, POSIX or Windows style', () => {
    for (const candidate of [
      '/etc/passwd',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      '\\\\server\\share',
    ]) {
      expect(resolveInsideSandbox(sandboxDir, candidate)).toMatchObject({
        ok: false,
        reason: 'absolute_path',
      });
    }
  });

  it('refuses a home-relative path, so `~/.ssh/id_rsa` is not a path at all', () => {
    expect(resolveInsideSandbox(sandboxDir, '~/.ssh/id_rsa')).toMatchObject({
      ok: false,
      reason: 'home_relative',
    });
    expect(resolveInsideSandbox(sandboxDir, '~')).toMatchObject({
      ok: false,
      reason: 'home_relative',
    });
  });

  it('refuses a NUL byte, which truncates a path inside the OS', () => {
    expect(resolveInsideSandbox(sandboxDir, 'notes.txt\u0000.png')).toMatchObject({
      ok: false,
      reason: 'null_byte',
    });
  });

  it('refuses something that is not a non-empty string', () => {
    for (const candidate of ['', '   ']) {
      expect(resolveInsideSandbox(sandboxDir, candidate)).toMatchObject({
        ok: false,
        reason: 'not_a_path',
      });
    }
  });

  it('refuses the sandbox root itself', () => {
    expect(resolveInsideSandbox(sandboxDir, '.')).toMatchObject({
      ok: false,
      reason: 'sandbox_root',
    });
    expect(resolveInsideSandbox(sandboxDir, '')).toMatchObject({ ok: false });
  });

  it('refuses a symlink that points out of the sandbox', () => {
    const outside = join(projectFolder, 'secret.txt');
    writeFileSync(outside, 'secret');
    let linked = false;
    try {
      symlinkSync(outside, join(sandboxDir, 'escape.txt'));
      linked = true;
    } catch {
      // Windows without Developer Mode refuses symlink creation; the check below still runs on the
      // directory variant, and CI (Linux) exercises this branch.
    }
    if (!linked) return;

    expect(resolveInsideSandbox(sandboxDir, 'escape.txt')).toMatchObject({
      ok: false,
      reason: 'symlink_escape',
    });
  });

  it('refuses a path whose parent folder is a symlink out of the sandbox', () => {
    const outside = join(projectFolder, 'elsewhere');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    let linked = false;
    try {
      symlinkSync(outside, join(sandboxDir, 'away'), 'dir');
      linked = true;
    } catch {
      // See above.
    }
    if (!linked) return;

    expect(resolveInsideSandbox(sandboxDir, 'away/secret.txt')).toMatchObject({
      ok: false,
      reason: 'symlink_escape',
    });
  });

  it('accepts a symlink that stays inside the sandbox', () => {
    mkdirSync(join(sandboxDir, 'data'));
    writeFileSync(join(sandboxDir, 'data', 'ok.txt'), 'ok');
    let linked = false;
    try {
      symlinkSync(join(sandboxDir, 'data'), join(sandboxDir, 'alias'), 'dir');
      linked = true;
    } catch {
      // See above.
    }
    if (!linked) return;

    expect(resolveInsideSandbox(sandboxDir, 'alias/ok.txt')).toMatchObject({ ok: true });
  });

  it('is not fooled by a sibling folder whose name starts with the sandbox name', () => {
    const sibling = `${sandboxDir}-evil`;
    mkdirSync(sibling, { recursive: true });
    expect(
      resolveInsideSandbox(sandboxDir, `..${sep}${sandboxDir.split(sep).at(-1)}-evil/x`),
    ).toMatchObject({ ok: false, reason: 'escapes_sandbox' });
  });
});

describe('TC-GRD-006 a refusal is denied AND logged (NFR-SEC-04)', () => {
  it('throws a `denied` ToolError and writes one warn line naming the path', () => {
    const logger = new RecordingToolLogger();

    expect(() =>
      assertInsideSandbox({
        sandboxDir,
        candidate: '../../x',
        toolName: 'sandbox_delete',
        operation: 'delete',
        logger,
        runId: 'run-7',
      }),
    ).toThrow(ToolError);

    const denials = logger.matching(SANDBOX_DENIED_MESSAGE);
    expect(denials).toHaveLength(1);
    expect(denials[0]?.level).toBe('warn');
    expect(denials[0]?.payload).toMatchObject({
      tool: 'sandbox_delete',
      operation: 'delete',
      reason: 'escapes_sandbox',
      requested: '../../x',
      runId: 'run-7',
    });
  });

  it('carries the reason in the error, so the ToolCall summary can say why', () => {
    const logger = new RecordingToolLogger();
    try {
      assertInsideSandbox({
        sandboxDir,
        candidate: '/etc/passwd',
        toolName: 'code_sandbox',
        operation: 'read',
        logger,
        runId: 'run-7',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.kind).toBe('denied');
      expect(toolError.details).toMatchObject({ reason: 'absolute_path' });
      expect(toolError.message).toContain('/etc/passwd');
    }
  });

  it('logs nothing and returns the absolute path when the path is legal', () => {
    const logger = new RecordingToolLogger();
    const path = assertInsideSandbox({
      sandboxDir,
      candidate: 'notes.txt',
      toolName: 'sandbox_delete',
      operation: 'delete',
      logger,
      runId: 'run-7',
    });
    expect(path).toBe(join(sandboxDir, 'notes.txt'));
    expect(logger.lines).toEqual([]);
  });
});

describe('review r1: a dangling link cannot hide where it points', () => {
  it('refuses a path through a dangling junction that points outside', () => {
    const outside = join(projectFolder, '..', `ace-outside-${Date.now()}`);
    symlinkSync(outside, join(sandboxDir, 'evil'), 'junction');
    const resolution = resolveInsideSandbox(sandboxDir, 'evil/new.txt');
    expect(resolution).toMatchObject({ ok: false, reason: 'symlink_escape' });
  });

  it('follows a chain of dangling links, and refuses a loop of them', () => {
    const outside = join(projectFolder, '..', `ace-outside2-${Date.now()}`);
    symlinkSync(outside, join(sandboxDir, 'b'), 'junction');
    symlinkSync(join(sandboxDir, 'b'), join(sandboxDir, 'a'), 'junction');
    expect(resolveInsideSandbox(sandboxDir, 'a/x')).toMatchObject({ reason: 'symlink_escape' });
    symlinkSync(join(sandboxDir, 'q'), join(sandboxDir, 'p'), 'junction');
    symlinkSync(join(sandboxDir, 'p'), join(sandboxDir, 'q'), 'junction');
    expect(resolveInsideSandbox(sandboxDir, 'p/x')).toMatchObject({ ok: false });
  });
});

describe('FR-TOOL-008 Windows path forms (agentic nodes path guard)', () => {
  const win = { platform: 'win32' } as const;
  const posix = { platform: 'linux' } as const;

  it('refuses the \\\\?\\ and \\\\.\\ device namespaces, either slash', () => {
    for (const candidate of ['\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', '//?/C:/x', '//./COM1']) {
      expect(resolveInsideSandbox(sandboxDir, candidate, win)).toMatchObject({
        ok: false,
        reason: 'device_namespace',
      });
      expect(resolveInsideSandbox(sandboxDir, candidate, posix)).toMatchObject({ ok: false });
    }
  });

  it('refuses a UNC path', () => {
    for (const candidate of ['\\\\server\\share\\x', '//server/share/x']) {
      expect(resolveInsideSandbox(sandboxDir, candidate, win)).toMatchObject({
        ok: false,
        reason: 'absolute_path',
      });
    }
  });

  it('refuses an alternate data stream on any segment, and a drive-relative path', () => {
    for (const candidate of [
      'file.txt:hidden',
      'src/a.ts::$DATA',
      'dir:x/file.txt',
      'C:file.txt',
    ]) {
      expect(resolveInsideSandbox(sandboxDir, candidate, win), candidate).toMatchObject({
        ok: false,
        reason: 'alternate_data_stream',
      });
    }
  });

  it('refuses a reserved device name on any segment, with or without an extension, any case', () => {
    for (const candidate of [
      'NUL',
      'nul',
      'con.txt',
      'src/CON',
      'src\\aux.tar.gz',
      'prn',
      'COM1',
      'com9.log',
      'LPT1',
      'lpt9.txt',
      'nul.',
      'NUL .txt',
      'con/x.txt',
      'COM\u00b9',
      'CONIN$',
    ]) {
      expect(resolveInsideSandbox(sandboxDir, candidate, win), candidate).toMatchObject({
        ok: false,
        reason: 'reserved_device_name',
      });
    }
  });

  it('still allows look-alikes of device names', () => {
    for (const candidate of [
      'console.txt',
      'nul1',
      'COM10',
      'LPT0x',
      'auxiliary/a.ts',
      'icon.png',
      'connect',
    ]) {
      expect(resolveInsideSandbox(sandboxDir, candidate, win), candidate).toMatchObject({
        ok: true,
      });
    }
  });

  // On a Windows host `a:b.txt` is drive-relative to `path.resolve`, so this runs on POSIX only.
  it.runIf(process.platform !== 'win32')('leaves `:` and device names alone on POSIX', () => {
    expect(resolveInsideSandbox(sandboxDir, 'a:b.txt', posix)).toMatchObject({ ok: true });
    expect(resolveInsideSandbox(sandboxDir, 'con.txt', posix)).toMatchObject({ ok: true });
  });

  it.runIf(process.platform === 'win32')('applies on this Windows host by default', () => {
    expect(resolveInsideSandbox(sandboxDir, 'NUL')).toMatchObject({
      reason: 'reserved_device_name',
    });
    expect(resolveInsideSandbox(sandboxDir, 'file.txt:hidden')).toMatchObject({
      reason: 'alternate_data_stream',
    });
  });

  it('lists every new reason', () => {
    expect(PATH_REFUSAL_REASONS).toEqual(
      expect.arrayContaining(['device_namespace', 'alternate_data_stream', 'reserved_device_name']),
    );
  });
});
