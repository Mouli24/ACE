import type {
  FileContent,
  FileEntry,
  FileSearchResult,
  FolderListing,
  RepoStatus,
  SaveFileResult,
  SourcesResult,
} from '@ace/contracts';

import type { ProjectFiles } from '../../ports/index.js';

export const AT = '2026-10-09T10:00:00.000Z';
export const TEXT: FileContent = {
  kind: 'text',
  path: 'a.ts',
  content: 'x',
  version: 'v1',
  eol: 'lf',
  bom: false,
  size: 1,
};
export const ENTRY: FileEntry = {
  path: 'n.ts',
  name: 'n.ts',
  kind: 'file',
  size: 0,
  mtime: AT,
  ignored: false,
};
export const LISTING: FolderListing = { path: '', items: [ENTRY] };
export const SAVED: SaveFileResult = { path: 'a.ts', version: 'v2', size: 1, mtime: AT };
export const STATUS: RepoStatus = { repo: false };
export const SOURCES: SourcesResult = {
  files: [{ path: 'a.ts', content: 'export const a = 1;' }],
  truncated: false,
  tsconfig: '{}',
};
export const FOUND: FileSearchResult = {
  files: [
    {
      path: 'a.ts',
      matches: [{ line: 1, column: 1, preview: 'x', previewOffset: 0, length: 1 }],
    },
  ],
  truncated: false,
  searchedFiles: 1,
};

export type Call = [method: string, ...args: unknown[]];

/** An in-memory `ProjectFiles` that records every call and answers fixed values. */
export function fakeFiles(overrides: Partial<ProjectFiles> = {}): ProjectFiles & { calls: Call[] } {
  const calls: Call[] = [];
  const files: ProjectFiles = {
    listFolder: async (...args) => {
      calls.push(['listFolder', ...args]);
      return LISTING;
    },
    read: async (...args) => {
      calls.push(['read', ...args]);
      return TEXT;
    },
    readRaw: async (...args) => {
      calls.push(['readRaw', ...args]);
      return { bytes: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/png' };
    },
    write: async (...args) => {
      calls.push(['write', ...args]);
      return SAVED;
    },
    create: async (...args) => {
      calls.push(['create', ...args]);
      return ENTRY;
    },
    move: async (...args) => {
      calls.push(['move', ...args]);
      return { ...ENTRY, path: 'b/n.ts' };
    },
    remove: async (...args) => {
      calls.push(['remove', ...args]);
    },
    listAll: async (...args) => {
      calls.push(['listAll', ...args]);
      return { files: ['a.ts'], truncated: false };
    },
    status: async (...args) => {
      calls.push(['status', ...args]);
      return STATUS;
    },
    search: async (...args) => {
      calls.push(['search', ...args]);
      return FOUND;
    },
    readSources: async (...args) => {
      calls.push(['readSources', ...args]);
      return SOURCES;
    },
    watch: () => () => undefined,
    ...overrides,
  };
  return Object.assign(files, { calls });
}
