import { describe, expect, it } from 'vitest';

import {
  CreateEntryRequestSchema,
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
