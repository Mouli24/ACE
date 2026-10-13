import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  FILE_LIST_LIMIT,
  FileSearchRequestSchema,
  SEARCH_FILE_MAX_BYTES,
  SEARCH_MAX_RESULTS,
  SEARCH_PREVIEW_MAX,
  searchPattern,
  type FileSearchFile,
  type FileSearchMatch,
  type FileSearchRequest,
  type FileSearchResult,
} from '@ace/contracts';
import ignoreModule from 'ignore';

import { listAllFiles } from './fs-files.js';

// `ignore` is CommonJS; under NodeNext the default import is the module (see ignore-rules.ts).
const ignore = ignoreModule.default;

/** How much of a file is searched for a NUL byte to call it binary — git's own heuristic. */
const SNIFF_BYTES = 8000;
/** How many files are read at once; they are searched in walk order all the same. */
const READ_BATCH = 16;
/** A match's preview starts this many characters before it when the line is too long to show. */
const PREVIEW_LEAD = 40;

export interface SearchOptions {
  /** One file stops being searched after this long; the result says `truncated` (default 1 s). */
  fileDeadlineMs?: number;
  /** The whole search stops after this long; the result says `truncated` (default 10 s). */
  totalDeadlineMs?: number;
  /** The clock the deadlines read (tests). */
  now?: () => number;
  /** How many files the walk lists at most (default {@link FILE_LIST_LIMIT}). */
  listLimit?: number;
}

/**
 * A comma-separated glob list as a matcher, in `.gitignore` syntax (the `ignore` package Forge's
 * Explorer already uses): `src` matches that folder at any depth and everything in it, `*.ts` any
 * TypeScript file, `src/**` with a file glob only under the root's `src`. Undefined when empty.
 */
function globMatcher(list: string | undefined): ((path: string) => boolean) | undefined {
  const patterns = (list ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');
  if (patterns.length === 0) return undefined;
  const rules = ignore().add(patterns);
  return (path) => rules.ignores(path);
}

/** The line around a match: the whole line when it fits, else a window that starts a little before it. */
function previewOf(
  line: string,
  start: number,
  length: number,
): Pick<FileSearchMatch, 'preview' | 'previewOffset'> {
  const indent = line.length - line.trimStart().length;
  let from = Math.min(indent, start);
  if (line.length - from > SEARCH_PREVIEW_MAX && start + length - from > SEARCH_PREVIEW_MAX) {
    from = Math.max(from, start - PREVIEW_LEAD);
  }
  return { preview: line.slice(from, from + SEARCH_PREVIEW_MAX), previewOffset: start - from };
}

/** Read a candidate: its text, or `undefined` for a file search skips (gone, too large, binary). */
async function readCandidate(absolute: string): Promise<string | undefined> {
  try {
    const stats = await fs.stat(absolute);
    if (!stats.isFile() || stats.size > SEARCH_FILE_MAX_BYTES) return undefined;
    const bytes = await fs.readFile(absolute);
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return undefined;
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    return bytes.subarray(bom ? 3 : 0).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Forge's Search (D299 Phase 4, design §6.4): every file the Explorer does not ignore — never
 * `node_modules`, `.git` or a `.gitignore` match — minus binary files and files over 2 MB, searched
 * line by line. The request is checked against the contract first, so a regex that does not
 * compile, one over 1,000 characters or one that repeats a repeating group is refused (a
 * `ZodError`, which the engine answers as 400 `validation_failed`) before a file is read.
 *
 * Bounded three ways, each reported as `truncated`: `maxResults` matches (2,000 at most), the walk's
 * own file cap, and two deadlines — one per file and one for the whole search — read between lines.
 */
export async function searchFiles(
  root: string,
  request: FileSearchRequest,
  options: SearchOptions = {},
): Promise<FileSearchResult> {
  const parsed = FileSearchRequestSchema.parse(request);
  const now = options.now ?? Date.now;
  const fileDeadlineMs = options.fileDeadlineMs ?? 1_000;
  const totalDeadlineMs = options.totalDeadlineMs ?? 10_000;
  const maxResults = parsed.maxResults ?? SEARCH_MAX_RESULTS;
  const pattern = searchPattern(parsed);
  const included = globMatcher(parsed.include);
  const excluded = globMatcher(parsed.exclude);

  const base = resolve(root);
  const startedAt = now();
  const list = await listAllFiles(base, options.listLimit ?? FILE_LIST_LIMIT);
  const candidates = list.files.filter(
    (path) => (included === undefined || included(path)) && !(excluded?.(path) ?? false),
  );

  const files: FileSearchFile[] = [];
  let found = 0;
  let searchedFiles = 0;
  let truncated = list.truncated;

  search: for (let batch = 0; batch < candidates.length; batch += READ_BATCH) {
    const paths = candidates.slice(batch, batch + READ_BATCH);
    const texts = await Promise.all(paths.map((path) => readCandidate(join(base, path))));
    for (const [index, path] of paths.entries()) {
      const text = texts[index];
      if (text === undefined) continue;
      const fileStart = now();
      if (fileStart - startedAt > totalDeadlineMs) {
        truncated = true;
        break search;
      }
      const deadline = Math.min(fileStart + fileDeadlineMs, startedAt + totalDeadlineMs);
      searchedFiles += 1;
      const matches: FileSearchMatch[] = [];
      const lines = text.split(/\r\n|\r|\n/);
      for (const [lineIndex, line] of lines.entries()) {
        if (now() > deadline) {
          truncated = true;
          break;
        }
        pattern.lastIndex = 0;
        for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
          if (match[0].length === 0) {
            // an empty match is no result, and must not hold the search on one spot
            pattern.lastIndex += 1;
            continue;
          }
          if (found === maxResults) {
            truncated = true;
            if (matches.length > 0) files.push({ path, matches });
            break search;
          }
          found += 1;
          matches.push({
            line: lineIndex + 1,
            column: match.index + 1,
            length: match[0].length,
            ...previewOf(line, match.index, match[0].length),
          });
        }
      }
      if (matches.length > 0) files.push({ path, matches });
    }
  }
  return { files, truncated, searchedFiles };
}
