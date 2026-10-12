import { describe, expect, it } from 'vitest';

import {
  CreateEntryRequestSchema,
  PACKAGE_MANAGERS,
  PROCESS_COMMAND_MAX,
  PROCESS_FRAME_MAX_CHARS,
  PROCESS_INPUT_MAX,
  PROCESS_OUTPUT_BATCH_MS,
  PROCESS_OUTPUT_MAX_CHARS,
  PROCESS_RECENT_MAX,
  PROCESS_RUNNING_MAX,
  ProcessDetailSchema,
  ProcessExitedPayloadSchema,
  ProcessInputRequestSchema,
  ProcessOutputPayloadSchema,
  ProcessStartRequestSchema,
  ProcessStartResponseSchema,
  ProcessSummarySchema,
  ProjectScriptsSchema,
  FILE_EDIT_MAX_BYTES,
  FILE_LIST_LIMIT,
  FILES_CHANGED_MAX,
  FileContentSchema,
  FileEntrySchema,
  FilePathQuerySchema,
  FilesChangedPayloadSchema,
  MoveEntryRequestSchema,
  RepoStatusSchema,
  RequiredFilePathQuerySchema,
  SaveFileRequestSchema,
} from '../workspace.js';

const ID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const AT = '2026-10-09T10:00:00.000Z';

describe('D299 FR-GIT-003 Forge project files contract', () => {
  it('pins the limits the spec gives (§6.1)', () => {
    expect(FILE_EDIT_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(FILE_LIST_LIMIT).toBe(50_000);
    expect(FILES_CHANGED_MAX).toBe(500);
  });

  it('describes a folder entry and refuses an unknown key', () => {
    const entry = { path: 'src', name: 'src', kind: 'folder', size: 0, mtime: AT, ignored: false };
    expect(FileEntrySchema.parse(entry)).toEqual(entry);
    expect(FileEntrySchema.safeParse({ ...entry, absolute: 'C:/x' }).success).toBe(false);
  });

  it('answers text with its version, line ending and BOM; binary and too-large carry no content', () => {
    const text = {
      kind: 'text',
      path: 'a.ts',
      content: 'x\r\n',
      version: 'abc',
      eol: 'crlf',
      bom: true,
      size: 6,
    };
    expect(FileContentSchema.parse(text)).toEqual(text);
    expect(FileContentSchema.parse({ kind: 'binary', path: 'a.png', size: 9 }).kind).toBe('binary');
    expect(
      FileContentSchema.safeParse({ kind: 'binary', path: 'a.png', size: 9, content: 'x' }).success,
    ).toBe(false);
    expect(FileContentSchema.parse({ kind: 'too_large', path: 'big.log', size: 9e6 }).kind).toBe(
      'too_large',
    );
  });

  it('saves against a base version, or null for a file that should not exist yet', () => {
    const base = { path: 'a.ts', content: '', eol: 'lf', bom: false };
    expect(SaveFileRequestSchema.parse({ ...base, baseVersion: 'v1' }).baseVersion).toBe('v1');
    expect(SaveFileRequestSchema.parse({ ...base, baseVersion: null }).baseVersion).toBeNull();
    expect(SaveFileRequestSchema.safeParse({ ...base }).success, 'baseVersion is required').toBe(
      false,
    );
    expect(SaveFileRequestSchema.safeParse({ ...base, path: '', baseVersion: null }).success).toBe(
      false,
    );
  });

  it('creates and moves non-empty paths only', () => {
    expect(CreateEntryRequestSchema.safeParse({ path: '', kind: 'file' }).success).toBe(false);
    expect(CreateEntryRequestSchema.parse({ path: 'a/b', kind: 'folder' }).kind).toBe('folder');
    expect(MoveEntryRequestSchema.safeParse({ from: 'a', to: '' }).success).toBe(false);
  });

  it('defaults a folder query to the root and requires a path for a file query', () => {
    expect(FilePathQuerySchema.parse({})).toEqual({ path: '' });
    expect(RequiredFilePathQuerySchema.safeParse({}).success).toBe(false);
  });

  it('says whether the folder is a repository', () => {
    expect(RepoStatusSchema.parse({ repo: false })).toEqual({ repo: false });
    const repo = {
      repo: true,
      branch: 'main',
      files: [{ path: 'src/a.ts', status: 'modified' }],
      truncated: false,
    };
    expect(RepoStatusSchema.parse(repo)).toEqual(repo);
    expect(
      RepoStatusSchema.safeParse({ ...repo, files: [{ path: 'x', status: 'ignored' }] }).success,
    ).toBe(false);
  });

  it('caps one files.changed burst at 500 changes', () => {
    const change = { path: 'a', kind: 'changed' };
    const ok = { projectId: ID, changes: [change], resync: false };
    expect(FilesChangedPayloadSchema.parse(ok)).toEqual(ok);
    const flood = { ...ok, changes: Array.from({ length: 501 }, () => change) };
    expect(FilesChangedPayloadSchema.safeParse(flood).success).toBe(false);
  });
});

describe('D301 the terminal’s processes contract (design §6.3)', () => {
  const summary = {
    id: ID,
    projectId: ID,
    label: 'dev',
    command: 'pnpm run dev',
    cwd: '',
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: AT,
  };

  it('pins the limits D301 gives', () => {
    expect(PROCESS_COMMAND_MAX).toBe(8_000);
    expect(PROCESS_INPUT_MAX).toBe(65_536);
    expect(PROCESS_OUTPUT_MAX_CHARS).toBe(1_048_576);
    expect(PROCESS_FRAME_MAX_CHARS).toBe(65_536);
    expect(PROCESS_RUNNING_MAX).toBe(8);
    expect(PROCESS_RECENT_MAX).toBe(20);
    expect(PROCESS_OUTPUT_BATCH_MS).toBe(50);
    expect([...PACKAGE_MANAGERS]).toEqual(['npm', 'pnpm', 'yarn', 'bun']);
  });

  it('starts either a typed command or a package.json script, never both', () => {
    const typed = { command: 'node -v', cwd: 'src', label: 'version' };
    const script = { script: 'dev', label: 'web' };
    expect(ProcessStartRequestSchema.parse(typed)).toEqual(typed);
    expect(ProcessStartRequestSchema.parse(script)).toEqual(script);
    expect(ProcessStartRequestSchema.safeParse({ command: 'a', script: 'dev' }).success).toBe(false);
    expect(ProcessStartRequestSchema.safeParse({}).success).toBe(false);
  });

  it('runs a script in the project root only: a script with a cwd is refused', () => {
    expect(ProcessStartRequestSchema.safeParse({ script: 'dev', cwd: 'packages/web' }).success).toBe(
      false,
    );
    expect(ProcessStartRequestSchema.safeParse({ script: 'dev', cwd: '' }).success).toBe(false);
  });

  it('refuses an empty or blank command, and one over 8,000 characters', () => {
    expect(ProcessStartRequestSchema.safeParse({ command: '' }).success).toBe(false);
    expect(ProcessStartRequestSchema.safeParse({ command: '   ' }).success).toBe(false);
    expect(ProcessStartRequestSchema.safeParse({ command: 'x'.repeat(8_000) }).success).toBe(true);
    expect(ProcessStartRequestSchema.safeParse({ command: 'x'.repeat(8_001) }).success).toBe(false);
  });

  it('answers a start with the process id, and takes up to 64 KB of input at a time', () => {
    expect(ProcessStartResponseSchema.parse({ processId: ID })).toEqual({ processId: ID });
    expect(ProcessInputRequestSchema.parse({ data: 'Ada\n' })).toEqual({ data: 'Ada\n' });
    expect(ProcessInputRequestSchema.safeParse({ data: 'x'.repeat(65_536) }).success).toBe(true);
    expect(ProcessInputRequestSchema.safeParse({ data: 'x'.repeat(65_537) }).success).toBe(false);
  });

  it('summarises a process, and the detail adds its kept output', () => {
    expect(ProcessSummarySchema.parse(summary)).toEqual(summary);
    const finished = { ...summary, status: 'exited', exitCode: 0, endedAt: AT };
    expect(ProcessSummarySchema.parse(finished)).toEqual(finished);
    expect(ProcessSummarySchema.safeParse({ ...summary, status: 'stopped' }).success).toBe(false);
    expect(ProcessSummarySchema.safeParse({ ...summary, pid: 12 }).success, 'no pid on the wire').toBe(
      false,
    );
    const detail = { ...summary, output: 'listening on 3000\n', truncated: false };
    expect(ProcessDetailSchema.parse(detail)).toEqual(detail);
    expect(ProcessDetailSchema.safeParse({ ...detail, extra: 1 }).success).toBe(false);
  });

  it('lists the project’s scripts with the package manager they run with', () => {
    const scripts = {
      packageManager: 'pnpm',
      scripts: [{ name: 'dev', command: 'vite' }],
    };
    expect(ProjectScriptsSchema.parse(scripts)).toEqual(scripts);
    expect(ProjectScriptsSchema.safeParse({ ...scripts, packageManager: 'deno' }).success).toBe(false);
  });

  it('streams output and an end, each naming the project and the process', () => {
    const output = { projectId: ID, processId: ID, stream: 'stderr', data: '\u001b[31mred\u001b[0m' };
    expect(ProcessOutputPayloadSchema.parse(output)).toEqual(output);
    expect(
      ProcessOutputPayloadSchema.safeParse({ ...output, data: 'x'.repeat(65_536) }).success,
    ).toBe(true);
    expect(
      ProcessOutputPayloadSchema.safeParse({ ...output, data: 'x'.repeat(65_537) }).success,
      'a bigger batch goes out as several frames',
    ).toBe(false);
    const exited = { projectId: ID, processId: ID, exitCode: null, signal: 'SIGKILL', status: 'exited' };
    expect(ProcessExitedPayloadSchema.parse(exited)).toEqual(exited);
    expect(
      ProcessExitedPayloadSchema.safeParse({ ...exited, status: 'running' }).success,
      'an end is never "running"',
    ).toBe(false);
  });
});
