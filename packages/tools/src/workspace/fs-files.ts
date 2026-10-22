import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, type Dirent, type Stats } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import {
  FILE_EDIT_MAX_BYTES,
  FILE_LIST_LIMIT,
  FILE_RAW_MAX_BYTES,
  type CreateEntryRequest,
  type FileContent,
  type FileEntry,
  type FileList,
  type FolderListing,
  type SaveFileRequest,
  type SaveFileResult,
} from '@ace/contracts';
import { WorkspaceFsError, type RawFile } from '@ace/engine';

import { projectWriteLocks, withPathLocks } from '../agent/locks.js';
import { resolveInsideSandbox } from '../sandbox/paths.js';
import { createIgnoreRules, type IgnoreRules } from './ignore-rules.js';
import { assertValidName, toAbsolute } from './resolve.js';

/*
 * Forge's project files on disk (D299, design §6.1). Every function takes the project's absolute
 * folder and a wire path, and confines the one to the other before touching anything (FR-GIT-008).
 */

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** How much of a file is searched for a NUL byte to call it binary — git's own heuristic. */
const SNIFF_BYTES = 8000;
/** Forge's own temporary save files; the watcher never reports them. */
export const SAVE_TEMP_SUFFIX = '.ace-save';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A content hash: equal bytes, equal version. */
export const versionOf = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 32);

const relOf = (base: string, absolute: string): string =>
  relative(base, absolute).split(sep).join('/');

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

async function statOrNull(absolute: string): Promise<Stats | null> {
  try {
    return await fs.stat(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function lstatOrNull(absolute: string): Promise<Stats | null> {
  try {
    return await fs.lstat(absolute);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

const notFound = (path: string): WorkspaceFsError =>
  new WorkspaceFsError('not_found', `${path === '' ? 'The project folder' : path} was not found.`);

/** The operating system refused: say so, rather than a 500 with no reason (design §10). */
function refusedByOs(error: unknown, path: string): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    throw new WorkspaceFsError('file_too_large', `${path} could not be saved: the disk is full.`, {
      reason: code,
    });
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'EBUSY') {
    throw new WorkspaceFsError(
      'protected_path',
      `${path} cannot be changed: the operating system refused access.`,
      { reason: code },
    );
  }
  throw error;
}

function entryOf(base: string, rules: IgnoreRules, absolute: string, stats: Stats): FileEntry {
  const path = relOf(base, absolute);
  const kind = stats.isDirectory() ? 'folder' : 'file';
  return {
    path,
    name: basename(absolute),
    kind,
    size: kind === 'file' ? stats.size : 0,
    mtime: stats.mtime.toISOString(),
    ignored: rules.isIgnored(path, kind === 'folder'),
  };
}

const byFolderThenName = (a: FileEntry, b: FileEntry): number =>
  a.kind !== b.kind ? (a.kind === 'folder' ? -1 : 1) : collator.compare(a.name, b.name);

/** [audit F-8] How many entries of one folder `listFolder` stats at once. */
const STAT_CONCURRENCY = 32;

/** `fn` over `items`, at most `limit` at a time, the answers in the items' order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const answers = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next;
      next += 1;
      answers[at] = await fn(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return answers;
}

/** `GET /files/tree`: one folder, one level (FR-GIT-003). */
export async function listFolder(root: string, path: string): Promise<FolderListing> {
  const base = resolve(root);
  const folder = toAbsolute(base, path, { allowRoot: true });
  const stats = await statOrNull(folder);
  if (stats === null) throw notFound(path);
  if (!stats.isDirectory())
    throw new WorkspaceFsError('invalid_path', `${path} is a file, not a folder.`);

  const rules = createIgnoreRules(base);
  const shown = (await fs.readdir(folder, { withFileTypes: true })).filter((dirent) => {
    if (dirent.name.endsWith(SAVE_TEMP_SUFFIX)) return false;
    const rel = relOf(base, join(folder, dirent.name));
    if (rules.isHidden(rel)) return false;
    // a link that resolves outside the project is not shown at all (FR-GIT-008)
    return !dirent.isSymbolicLink() || resolveInsideSandbox(base, rel).ok;
  });
  // a stat per entry, a bounded number at a time rather than one after another ([audit F-8])
  const statted = await mapLimited(shown, STAT_CONCURRENCY, (dirent) =>
    statOrNull(join(folder, dirent.name)),
  );
  const items: FileEntry[] = [];
  shown.forEach((dirent, index) => {
    const entryStats = statted[index];
    if (entryStats === null || entryStats === undefined) return;
    if (!entryStats.isFile() && !entryStats.isDirectory()) return;
    items.push(entryOf(base, rules, join(folder, dirent.name), entryStats));
  });
  items.sort(byFolderThenName);
  return { path: relOf(base, folder), items };
}

const looksBinary = (bytes: Buffer): boolean => bytes.subarray(0, SNIFF_BYTES).includes(0);

/** `GET /files/content`: text with its version, or a description (FR-GIT-004). */
export async function readFile(root: string, path: string): Promise<FileContent> {
  const base = resolve(root);
  const absolute = toAbsolute(base, path);
  const stats = await statOrNull(absolute);
  if (stats === null || !stats.isFile()) throw notFound(path);
  const rel = relOf(base, absolute);
  if (stats.size > FILE_EDIT_MAX_BYTES) return { kind: 'too_large', path: rel, size: stats.size };

  const bytes = await fs.readFile(absolute);
  if (looksBinary(bytes)) return { kind: 'binary', path: rel, size: bytes.length };
  const bom = bytes.subarray(0, 3).equals(BOM);
  const body = bytes.subarray(bom ? 3 : 0);
  const content = body.toString('utf8');
  // Not valid UTF-8: decoding replaced bytes, and a save would write the replacements back.
  if (!Buffer.from(content, 'utf8').equals(body))
    return { kind: 'binary', path: rel, size: bytes.length };

  return {
    kind: 'text',
    path: rel,
    content,
    version: versionOf(bytes),
    eol: content.includes('\r\n') ? 'crlf' : 'lf',
    bom,
    size: bytes.length,
  };
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

/** `GET /files/raw`: the bytes, for the image preview (§6.2). */
export async function readRaw(
  root: string,
  path: string,
  maxBytes: number = FILE_RAW_MAX_BYTES,
): Promise<RawFile> {
  const absolute = toAbsolute(resolve(root), path);
  const stats = await statOrNull(absolute);
  if (stats === null || !stats.isFile()) throw notFound(path);
  if (stats.size > maxBytes) {
    throw new WorkspaceFsError('file_too_large', `${path} is too large to preview.`, { maxBytes });
  }
  const bytes = await fs.readFile(absolute);
  return {
    bytes: Uint8Array.from(bytes).buffer,
    contentType: IMAGE_TYPES[extname(absolute).toLowerCase()] ?? 'application/octet-stream',
  };
}

/** Windows refuses a rename over a file another process holds for a moment (an indexer, AV). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
      await new Promise((settle) => setTimeout(settle, 25 * 2 ** attempt));
    }
  }
}

/** A temp file in the same folder, then a rename: a reader never sees half a file. */
export async function atomicWrite(
  absolute: string,
  bytes: Uint8Array,
  mode: number | undefined,
): Promise<void> {
  const temp = join(
    dirname(absolute),
    `.${basename(absolute)}.${randomBytes(6).toString('hex')}${SAVE_TEMP_SUFFIX}`,
  );
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx' });
    if (mode !== undefined) await fs.chmod(temp, mode);
    await renameWithRetry(temp, absolute);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * `PUT /files/content`: an atomic save that never overwrites a change it has not seen. PG-5.2
 * (D361): the version check and the write happen under the file's write lock — the one an agent's
 * `write_file`/`edit_file` takes — so a save and an agent's edit of one file never interleave.
 */
export async function writeFile(root: string, request: SaveFileRequest): Promise<SaveFileResult> {
  const base = resolve(root);
  const absolute = toAbsolute(base, request.path, { write: true });
  const text =
    request.eol === 'crlf'
      ? request.content.replace(/\r?\n/g, '\r\n')
      : request.content.replace(/\r\n/g, '\n');
  const bytes = Buffer.concat([request.bom ? BOM : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
  if (bytes.length > FILE_EDIT_MAX_BYTES) {
    throw new WorkspaceFsError('file_too_large', `${request.path} is over the 2 MB Forge saves.`, {
      maxBytes: FILE_EDIT_MAX_BYTES,
    });
  }

  return projectWriteLocks.withLock(absolute, () => saveLocked(base, absolute, request, bytes));
}

async function saveLocked(
  base: string,
  absolute: string,
  request: SaveFileRequest,
  bytes: Buffer,
): Promise<SaveFileResult> {
  const current = await statOrNull(absolute);
  if (current !== null && !current.isFile())
    throw new WorkspaceFsError('exists', `${request.path} is a folder.`);
  const currentVersion = current === null ? null : versionOf(await fs.readFile(absolute));
  if (currentVersion !== request.baseVersion) {
    throw new WorkspaceFsError(
      'file_changed',
      currentVersion === null
        ? `${request.path} was deleted after it was opened.`
        : `${request.path} changed on disk after it was opened.`,
      { currentVersion },
    );
  }
  const parent = await statOrNull(dirname(absolute));
  if (parent === null || !parent.isDirectory()) throw notFound(relOf(base, dirname(absolute)));

  try {
    // through an existing link, to its (confined) real target, so the link survives
    const destination = current === null ? absolute : await fs.realpath(absolute);
    await atomicWrite(destination, bytes, current?.mode);
  } catch (error) {
    refusedByOs(error, request.path);
  }
  const stats = await fs.stat(absolute);
  return {
    path: relOf(base, absolute),
    version: versionOf(bytes),
    size: bytes.length,
    mtime: stats.mtime.toISOString(),
  };
}

/** `POST /files/entries`: an empty file or a folder; missing parent folders are created. */
export async function createEntry(root: string, request: CreateEntryRequest): Promise<FileEntry> {
  const base = resolve(root);
  const absolute = toAbsolute(base, request.path, { write: true });
  for (const segment of relOf(base, absolute).split('/')) assertValidName(segment);
  // PG-5.2: under the path's write lock, as an agent's write of the same path is
  return projectWriteLocks.withLock(absolute, () => createLocked(base, absolute, request));
}

async function createLocked(
  base: string,
  absolute: string,
  request: CreateEntryRequest,
): Promise<FileEntry> {
  if ((await lstatOrNull(absolute)) !== null)
    throw new WorkspaceFsError('exists', `${request.path} already exists.`);
  try {
    await fs.mkdir(dirname(absolute), { recursive: true });
    if (request.kind === 'folder') await fs.mkdir(absolute);
    else await fs.writeFile(absolute, '', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new WorkspaceFsError('exists', `${request.path} already exists.`);
    }
    refusedByOs(error, request.path);
  }
  return entryOf(base, createIgnoreRules(base), absolute, await fs.stat(absolute));
}

/** A file's identity on its disk, exactly: `stat(..., { bigint: true })`'s `dev` and `ino`. */
export interface EntryId {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** A project-relative path as a case-insensitive disk compares it. */
const folded = (rel: string): string => rel.normalize('NFC').toLowerCase();

/**
 * Whether `from` and `to` are one entry under two spellings — a case-only rename on a
 * case-insensitive disk — so moving one onto the other is a rename, not an overwrite (review C1).
 * Both must hold: the project-relative paths are equal ignoring case (after Unicode
 * normalisation), and the disk reports the same file id. The ids are bigints because NTFS file
 * ids exceed 2^53: as Numbers, two neighbouring files can round to one id.
 */
export function isSameEntry(from: string, to: string, a: EntryId, b: EntryId): boolean {
  return folded(from) === folded(to) && a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
}

async function sameEntry(
  relFrom: string,
  relTo: string,
  from: string,
  to: string,
): Promise<boolean> {
  if (folded(relFrom) !== folded(relTo)) return false;
  const [a, b] = await Promise.all([
    fs.stat(from, { bigint: true }),
    fs.stat(to, { bigint: true }),
  ]);
  return isSameEntry(relFrom, relTo, a, b);
}

/** `POST /files/move`: rename or move inside the project. */
export async function moveEntry(root: string, from: string, to: string): Promise<FileEntry> {
  const base = resolve(root);
  const source = toAbsolute(base, from, { write: true });
  const target = toAbsolute(base, to, { write: true });
  assertValidName(basename(target));
  // PG-5.2: both ends under their write locks, taken in one order
  return withPathLocks(projectWriteLocks, [source, target], () =>
    moveLocked(base, from, to, source, target),
  );
}

async function moveLocked(
  base: string,
  from: string,
  to: string,
  source: string,
  target: string,
): Promise<FileEntry> {
  const sourceStats = await lstatOrNull(source);
  if (sourceStats === null) throw notFound(from);

  const relSource = relOf(base, source);
  const relTarget = relOf(base, target);
  if (sourceStats.isDirectory() && `${relTarget}/`.startsWith(`${relSource}/`)) {
    throw new WorkspaceFsError('invalid_path', 'A folder cannot be moved into itself.');
  }
  if (relSource !== relTarget) {
    const existing = await lstatOrNull(target);
    // anything else that exists is never replaced (review C1)
    if (existing !== null && !(await sameEntry(relSource, relTarget, source, target))) {
      throw new WorkspaceFsError('exists', `${to} already exists.`);
    }
    try {
      await fs.mkdir(dirname(target), { recursive: true });
      await renameWithRetry(source, target);
    } catch (error) {
      refusedByOs(error, from);
    }
  }
  return entryOf(base, createIgnoreRules(base), target, await fs.stat(target));
}

/**
 * `DELETE /files/entries`: a file, or a folder with everything in it. Permanent in Phase 1 — the
 * UI says so before asking; Phase 3 captures a `user_delete` checkpoint first (D300).
 */
export async function removeEntry(root: string, path: string): Promise<void> {
  const absolute = toAbsolute(resolve(root), path, { write: true });
  // PG-5.2: under the path's write lock, as an agent's write of the same path is
  await projectWriteLocks.withLock(absolute, async () => {
    if ((await lstatOrNull(absolute)) === null) throw notFound(path);
    try {
      await fs.rm(absolute, { recursive: true, force: false, maxRetries: 3 });
    } catch (error) {
      refusedByOs(error, path);
    }
  });
}

/**
 * `GET /files/list`: every file that is not hidden or ignored, breadth first so shallow files come
 * first, never following links, stopping at `limit` (quick open).
 */
export async function listAllFiles(
  root: string,
  limit: number = FILE_LIST_LIMIT,
): Promise<FileList> {
  const base = resolve(root);
  const rules = createIgnoreRules(base);
  const files: string[] = [];
  const queue: string[] = [''];
  for (let next = 0; next < queue.length; next += 1) {
    const folder = queue[next] ?? '';
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(join(base, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => collator.compare(a.name, b.name));
    for (const dirent of dirents) {
      if (dirent.name.endsWith(SAVE_TEMP_SUFFIX)) continue;
      const rel = folder === '' ? dirent.name : `${folder}/${dirent.name}`;
      if (rules.isHidden(rel)) continue;
      if (dirent.isDirectory()) {
        if (!rules.isIgnored(rel, true)) queue.push(rel);
        continue;
      }
      if (!dirent.isFile() || rules.isIgnored(rel, false)) continue;
      files.push(rel);
      if (files.length >= limit) return { files, truncated: true };
    }
  }
  return { files, truncated: false };
}
