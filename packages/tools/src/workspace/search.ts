import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

import {
  FILE_LIST_LIMIT,
  FileSearchRequestSchema,
  SEARCH_FILE_MAX_BYTES,
  SEARCH_MAX_RESULTS,
  SEARCH_PREVIEW_MAX,
  SEARCH_REGEX_DEADLINE_MS,
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
const LINE_BREAK = /\r\n|\r|\n/;

export interface SearchOptions {
  /** Literal search: one file stops being searched after this long (default 1 s). */
  fileDeadlineMs?: number;
  /** Literal search: the whole search stops after this long (default 10 s). */
  totalDeadlineMs?: number;
  /** Regex search: the worker is ended after this long, wherever it is (default 5 s). */
  regexDeadlineMs?: number;
  /** The clock the literal deadlines read (tests). */
  now?: () => number;
  /** How many files the walk lists at most (default {@link FILE_LIST_LIMIT}). */
  listLimit?: number;
  /** The request went away: the search stops, a regex worker is ended, and what was found answers. */
  signal?: AbortSignal;
  /** Tests: the worker a regex search starts. */
  onWorker?: (worker: Worker) => void;
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
 * Where a pattern matches in some lines, as flat triples `[line, index, length, …]`: at most `limit`
 * matches, empty matches skipped (they are no result, and must not hold the search on one spot).
 * The same loop runs in the worker, as {@link WORKER_SOURCE}.
 */
function matchLines(pattern: RegExp, lines: readonly string[], limit: number): number[] {
  const found: number[] = [];
  for (let line = 0; line < lines.length && found.length < limit * 3; line += 1) {
    const text = lines[line] ?? '';
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      found.push(line, match.index, match[0].length);
      if (found.length >= limit * 3) break;
    }
  }
  return found;
}

/**
 * The regex worker (D299 Phase 4 fix C1). A pattern can backtrack for minutes on one line, and no
 * check between lines can interrupt `exec`; on the engine's thread that would freeze every request,
 * socket and run. So regex matching runs here, in a thread the search ends with `terminate()` at
 * its deadline or when the request is aborted. Plain JavaScript, evaluated as is: it needs no
 * module resolution, so it runs the same from the sources and from `dist`.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const pattern = new RegExp(workerData.source, workerData.flags);
parentPort.on('message', (job) => {
  const found = [];
  for (let line = 0; line < job.lines.length && found.length < job.limit * 3; line += 1) {
    const text = job.lines[line];
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      found.push(line, match.index, match[0].length);
      if (found.length >= job.limit * 3) break;
    }
  }
  parentPort.postMessage({ id: job.id, found });
});
`;

interface RegexWorker {
  /** The matches in one file's lines, or `undefined` once the worker was ended. */
  match(lines: readonly string[], limit: number): Promise<number[] | undefined>;
  /** Ends the thread at once; a match in flight answers `undefined`. */
  stop(): Promise<void>;
}

function startRegexWorker(pattern: RegExp, onWorker: SearchOptions['onWorker']): RegexWorker {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { source: pattern.source, flags: pattern.flags },
  });
  onWorker?.(worker);
  let ended = false;
  let jobs = 0;
  let pending: { id: number; settle: (found: number[] | undefined) => void } | undefined;
  const answer = (found: number[] | undefined): void => {
    const waiting = pending;
    pending = undefined;
    waiting?.settle(found);
  };
  worker.on('message', (reply: { id: number; found: number[] }) => {
    if (pending?.id === reply.id) answer(reply.found);
  });
  const end = (): void => {
    ended = true;
    answer(undefined);
  };
  worker.on('error', end);
  worker.on('exit', end);
  return {
    match(lines, limit) {
      if (ended) return Promise.resolve(undefined);
      jobs += 1;
      const id = jobs;
      return new Promise((settle) => {
        pending = { id, settle };
        worker.postMessage({ id, lines, limit });
      });
    },
    async stop() {
      end();
      await worker.terminate();
    },
  };
}

/**
 * Forge's Search (D299 Phase 4, design §6.4): every file the Explorer does not ignore — never
 * `node_modules`, `.git` or a `.gitignore` match — minus binary files and files over 2 MB, searched
 * line by line. The request is checked against the contract first, so a regex that does not
 * compile, one over 1,000 characters or one that repeats a repeating group is refused (a
 * `ZodError`, which the engine answers as 400 `validation_failed`) before a file is read.
 *
 * A literal search is linear and runs here, bounded by a per-file and a total deadline read
 * between lines. A regex search runs in a worker thread with a hard deadline (fix C1): at 5 s the
 * worker is terminated and the files finished by then are the answer, with `timedOut`. Aborting
 * the request (`signal`) stops either kind the same way. Every early stop — `maxResults` (2,000 at
 * most), the walk's own file cap, a deadline, an abort — is reported as `truncated`.
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
  const { signal } = options;
  /** Read afresh each time: the request can go away while the search runs. */
  const aborted = (): boolean => signal?.aborted === true;

  const files: FileSearchFile[] = [];
  let found = 0;
  let searchedFiles = 0;
  /** Set from the walk: a list that was cut short already makes the answer partial. */
  let truncated: boolean;
  let timedOut = false;
  if (aborted()) return { files, truncated: true, searchedFiles, timedOut };

  /** Why the search stopped early, once it has. */
  let stopped: 'deadline' | 'abort' | undefined;
  const worker = parsed.regex === true ? startRegexWorker(pattern, options.onWorker) : undefined;
  const halt = (reason: 'deadline' | 'abort'): void => {
    if (stopped !== undefined) return;
    stopped = reason;
    void worker?.stop();
  };
  const timer =
    worker === undefined
      ? undefined
      : setTimeout(() => halt('deadline'), options.regexDeadlineMs ?? SEARCH_REGEX_DEADLINE_MS);
  const onAbort = (): void => halt('abort');
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const base = resolve(root);
    const startedAt = now();
    const list = await listAllFiles(base, options.listLimit ?? FILE_LIST_LIMIT);
    truncated = list.truncated;
    const candidates = list.files.filter(
      (path) => (included === undefined || included(path)) && !(excluded?.(path) ?? false),
    );

    search: for (let batch = 0; batch < candidates.length; batch += READ_BATCH) {
      if (stopped !== undefined) break;
      const paths = candidates.slice(batch, batch + READ_BATCH);
      const texts = await Promise.all(paths.map((path) => readCandidate(join(base, path))));
      for (const [index, path] of paths.entries()) {
        const text = texts[index];
        if (text === undefined) continue;
        if (stopped !== undefined) break search;
        const lines = text.split(LINE_BREAK);
        const limit = maxResults - found + 1;
        let positions: number[];
        if (worker === undefined) {
          const fileStart = now();
          if (fileStart - startedAt > totalDeadlineMs) {
            timedOut = true;
            truncated = true;
            break search;
          }
          const deadline = Math.min(fileStart + fileDeadlineMs, startedAt + totalDeadlineMs);
          positions = [];
          for (const [lineIndex, line] of lines.entries()) {
            if (now() > deadline || aborted()) {
              timedOut ||= !aborted();
              truncated = true;
              break;
            }
            const inLine = matchLines(pattern, [line], limit - positions.length / 3);
            for (let at = 0; at < inLine.length; at += 3) {
              positions.push(lineIndex, inLine[at + 1] ?? 0, inLine[at + 2] ?? 0);
            }
            if (positions.length >= limit * 3) break;
          }
        } else {
          const answer = await worker.match(lines, limit);
          if (answer === undefined) break search;
          positions = answer;
        }
        searchedFiles += 1;

        const matches: FileSearchMatch[] = [];
        for (let at = 0; at < positions.length; at += 3) {
          if (found === maxResults) {
            truncated = true;
            if (matches.length > 0) files.push({ path, matches });
            break search;
          }
          const lineIndex = positions[at] ?? 0;
          const start = positions[at + 1] ?? 0;
          const length = positions[at + 2] ?? 0;
          found += 1;
          matches.push({
            line: lineIndex + 1,
            column: start + 1,
            length,
            ...previewOf(lines[lineIndex] ?? '', start, length),
          });
        }
        if (matches.length > 0) files.push({ path, matches });
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await worker?.stop();
  }
  return {
    files,
    truncated: truncated || stopped !== undefined,
    searchedFiles,
    timedOut: timedOut || stopped === 'deadline',
  };
}
