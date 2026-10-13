import {
  FILE_EDIT_MAX_BYTES,
  SEARCH_MAX_RESULTS,
  SEARCH_PREVIEW_MAX,
  searchPattern,
  type CreateEntryRequest,
  type FileContent,
  type FileEntry,
  type FileList,
  type FileSearchMatch,
  type FileSearchRequest,
  type FileSearchResult,
  type FolderListing,
  type SaveFileRequest,
  type SaveFileResult,
} from '@ace/contracts';

/**
 * A project folder for the mock engine (D299): path → entry, with folders explicit so an empty one
 * can exist. The rules mirror `@ace/tools`' `fs-files.ts` closely enough for the UI to meet every
 * refusal it can meet on the real engine.
 */
export interface MockFsEntry {
  kind: 'file' | 'folder';
  content: string;
  mtime: string;
}
export type MockFs = Record<string, MockFsEntry>;

export type MockFsErrorCode =
  | 'not_found'
  | 'exists'
  | 'file_changed'
  | 'file_too_large'
  | 'outside_project'
  | 'protected_path'
  | 'invalid_path';

export class MockFsError extends Error {
  constructor(
    readonly code: MockFsErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** FNV-1a plus the length: a stable, cheap stand-in for the engine's content hash. */
export function mockVersion(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}${content.length.toString(16)}`;
}

const IGNORED = new Set(['node_modules', '.ace', 'dist', 'build', '.next', '__pycache__', '.venv']);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const now = (): string => new Date().toISOString();
const bytesOf = (text: string): number => new TextEncoder().encode(text).length;
const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const asSeen = (segment: string): string =>
  (segment.split(':')[0] ?? '').replace(/[. ]+$/, '').toLowerCase();
const isHidden = (path: string): boolean =>
  path.split('/').some((segment) => asSeen(segment) === '.git');
const isIgnored = (path: string, kind: MockFsEntry['kind']): boolean =>
  path
    .split('/')
    .some((segment, i, all) => (i < all.length - 1 || kind === 'folder') && IGNORED.has(segment));

/** The engine's confinement, in miniature (FR-GIT-008). */
function checkPath(path: string, write: boolean): string {
  const clean = path.split('\\').join('/').replace(/^\.\//, '');
  const escapes =
    clean.includes('\u0000') ||
    clean.startsWith('/') ||
    /^[A-Za-z]:/.test(clean) ||
    clean.startsWith('~') ||
    clean.split('/').includes('..');
  if (escapes) throw new MockFsError('outside_project', 'That path is outside the project folder.');
  if (clean === '' || clean === '.')
    throw new MockFsError('invalid_path', 'That names the project folder itself.');
  if (write) {
    const folder = clean
      .split('/')
      .map(asSeen)
      .find((segment) => segment === '.git' || segment === '.ace');
    if (folder !== undefined) {
      throw new MockFsError('protected_path', `Forge does not change anything inside ${folder}/.`, {
        folder,
      });
    }
  }
  return clean;
}

function assertValidName(name: string): void {
  if (
    name === '' ||
    /[<>:"|?*]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)
  ) {
    throw new MockFsError('invalid_path', `"${name}" cannot be used as a name.`, { path: name });
  }
}

const notFound = (path: string) => new MockFsError('not_found', `${path} was not found.`);

function entryOf(fs: MockFs, path: string): FileEntry {
  const entry = fs[path];
  if (entry === undefined) throw notFound(path);
  return {
    path,
    name: nameOf(path),
    kind: entry.kind,
    size: entry.kind === 'file' ? bytesOf(entry.content) : 0,
    mtime: entry.mtime,
    ignored: isIgnored(path, entry.kind),
  };
}

export function ensureFolders(fs: MockFs, path: string): void {
  for (let folder = parentOf(path); folder !== ''; folder = parentOf(folder)) {
    if (fs[folder] === undefined) fs[folder] = { kind: 'folder', content: '', mtime: now() };
  }
}

export function listFolder(fs: MockFs, path: string): FolderListing {
  const folder = path === '' ? '' : checkPath(path, false);
  if (folder !== '' && fs[folder]?.kind !== 'folder') {
    throw fs[folder] === undefined
      ? notFound(folder)
      : new MockFsError('invalid_path', `${folder} is a file.`);
  }
  const items = Object.keys(fs)
    .filter((p) => parentOf(p) === folder && !isHidden(p))
    .map((p) => entryOf(fs, p))
    .sort((a, b) =>
      a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : collator.compare(a.name, b.name),
    );
  return { path: folder, items };
}

export function readFile(fs: MockFs, path: string): FileContent {
  const file = checkPath(path, false);
  const entry = fs[file];
  if (entry?.kind !== 'file') throw notFound(file);
  const size = bytesOf(entry.content);
  if (size > FILE_EDIT_MAX_BYTES) return { kind: 'too_large', path: file, size };
  if (entry.content.includes('\u0000')) return { kind: 'binary', path: file, size };
  return {
    kind: 'text',
    path: file,
    content: entry.content,
    version: mockVersion(entry.content),
    eol: entry.content.includes('\r\n') ? 'crlf' : 'lf',
    bom: false,
    size,
  };
}

export function writeFile(fs: MockFs, request: SaveFileRequest): SaveFileResult {
  const file = checkPath(request.path, true);
  const entry = fs[file];
  if (entry?.kind === 'folder') throw new MockFsError('exists', `${file} is a folder.`);
  const currentVersion = entry === undefined ? null : mockVersion(entry.content);
  if (currentVersion !== request.baseVersion) {
    throw new MockFsError('file_changed', `${file} changed on disk after it was opened.`, {
      currentVersion,
    });
  }
  const parent = parentOf(file);
  if (parent !== '' && fs[parent]?.kind !== 'folder') throw notFound(parent);
  const text =
    request.eol === 'crlf'
      ? request.content.replace(/\r?\n/g, '\r\n')
      : request.content.replace(/\r\n/g, '\n');
  if (bytesOf(text) > FILE_EDIT_MAX_BYTES)
    throw new MockFsError('file_too_large', `${file} is over 2 MB.`);
  const mtime = now();
  fs[file] = { kind: 'file', content: text, mtime };
  return { path: file, version: mockVersion(text), size: bytesOf(text), mtime };
}

export function createEntry(fs: MockFs, request: CreateEntryRequest): FileEntry {
  const path = checkPath(request.path, true);
  path.split('/').forEach(assertValidName);
  if (fs[path] !== undefined) throw new MockFsError('exists', `${path} already exists.`);
  ensureFolders(fs, path);
  fs[path] = { kind: request.kind, content: '', mtime: now() };
  return entryOf(fs, path);
}

export function moveEntry(fs: MockFs, from: string, to: string): FileEntry {
  const source = checkPath(from, true);
  const target = checkPath(to, true);
  assertValidName(nameOf(target));
  const entry = fs[source];
  if (entry === undefined) throw notFound(source);
  if (entry.kind === 'folder' && `${target}/`.startsWith(`${source}/`)) {
    throw new MockFsError('invalid_path', 'A folder cannot be moved into itself.');
  }
  // a case-only rename is the same entry on Windows and macOS
  if (fs[target] !== undefined && source.toLowerCase() !== target.toLowerCase()) {
    throw new MockFsError('exists', `${target} already exists.`);
  }
  ensureFolders(fs, target);
  for (const key of Object.keys(fs)) {
    if (key !== source && !key.startsWith(`${source}/`)) continue;
    const value = fs[key];
    if (value === undefined) continue;
    delete fs[key];
    fs[`${target}${key.slice(source.length)}`] = value;
  }
  return entryOf(fs, target);
}

export function removeEntry(fs: MockFs, path: string): void {
  const target = checkPath(path, true);
  if (fs[target] === undefined) throw notFound(target);
  for (const key of Object.keys(fs)) {
    if (key === target || key.startsWith(`${target}/`)) delete fs[key];
  }
}

export function listAll(fs: MockFs): FileList {
  const depth = (path: string): number => path.split('/').length;
  const files = Object.keys(fs)
    .filter((path) => fs[path]?.kind === 'file' && !isHidden(path) && !isIgnored(path, 'file'))
    .sort((a, b) => depth(a) - depth(b) || collator.compare(a, b));
  return { files, truncated: false };
}

/**
 * One comma-separated glob list in `.gitignore` syntax, as the engine reads Search's include and
 * exclude: `src` matches that folder anywhere and what is in it, `*.ts` any TypeScript file, a
 * pattern with a slash in it is anchored at the root. Undefined when the list is empty.
 */
function globMatcher(list: string | undefined): ((path: string) => boolean) | undefined {
  const patterns = (list ?? '')
    .split(',')
    .map((pattern) => pattern.trim().replace(/\/+$/, ''))
    .filter((pattern) => pattern !== '');
  if (patterns.length === 0) return undefined;
  const regexes = patterns.map((pattern) => {
    const anchored = pattern.includes('/');
    const glob = pattern.replace(/^\//, '');
    let body = '';
    for (let i = 0; i < glob.length; i += 1) {
      const char = glob[i] ?? '';
      if (char === '*' && glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        body += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else if (char === '*') body += '[^/]*';
      else if (char === '?') body += '[^/]';
      else body += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`${anchored ? '^' : '(^|/)'}${body}(/.*)?$`, 'i');
  });
  return (path) => regexes.some((regex) => regex.test(path));
}

/** `POST /files/search` on the mock engine: the engine's rules over the mock's files (D299 Phase 4). */
export function searchFiles(fs: MockFs, request: FileSearchRequest): FileSearchResult {
  const pattern = searchPattern(request);
  const max = request.maxResults ?? SEARCH_MAX_RESULTS;
  const included = globMatcher(request.include);
  const excluded = globMatcher(request.exclude);
  const files: FileSearchResult['files'] = [];
  let found = 0;
  let searchedFiles = 0;
  for (const path of listAll(fs).files) {
    if ((included !== undefined && !included(path)) || excluded?.(path) === true) continue;
    const content = fs[path]?.content ?? '';
    if (content.includes('\u0000') || bytesOf(content) > FILE_EDIT_MAX_BYTES) continue;
    searchedFiles += 1;
    const matches: FileSearchMatch[] = [];
    for (const [index, line] of content.split(/\r\n|\r|\n/).entries()) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
        if (match[0].length === 0) {
          pattern.lastIndex += 1;
          continue;
        }
        if (found === max) {
          if (matches.length > 0) files.push({ path, matches });
          return { files, truncated: true, searchedFiles };
        }
        found += 1;
        const from = Math.min(line.length - line.trimStart().length, match.index);
        matches.push({
          line: index + 1,
          column: match.index + 1,
          preview: line.slice(from, from + SEARCH_PREVIEW_MAX),
          previewOffset: match.index - from,
          length: match[0].length,
        });
      }
    }
    if (matches.length > 0) files.push({ path, matches });
  }
  return { files, truncated: false, searchedFiles };
}
