import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SEARCH_FILE_MAX_BYTES, type FileSearchRequest } from '@ace/contracts';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Worker } from 'node:worker_threads';

import { searchFiles } from './search.js';

let root: string;

function put(path: string, content: string | Buffer): void {
  const absolute = join(root, ...path.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

const search = (request: FileSearchRequest, options?: Parameters<typeof searchFiles>[2]) =>
  searchFiles(root, request, options);

/** `path:line:column` for every match, in result order. */
const where = (result: Awaited<ReturnType<typeof searchFiles>>): string[] =>
  result.files.flatMap((file) =>
    file.matches.map((match) => `${file.path}:${match.line}:${match.column}`),
  );

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-search-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('D299 Phase 4 searchFiles', () => {
  it('finds literal text with its line, column, length and preview, ignoring case by default', async () => {
    put('a.ts', 'const x = 1;\nexport const TODO = "todo";\n');
    const result = await search({ query: 'todo' });
    expect(result).toEqual({
      files: [
        {
          path: 'a.ts',
          matches: [
            {
              line: 2,
              column: 14,
              preview: 'export const TODO = "todo";',
              previewOffset: 13,
              length: 4,
            },
            {
              line: 2,
              column: 22,
              preview: 'export const TODO = "todo";',
              previewOffset: 21,
              length: 4,
            },
          ],
        },
      ],
      truncated: false,
      searchedFiles: 1,
      timedOut: false,
    });
  });

  it('skips node_modules, the default folders, .gitignore matches and .git', async () => {
    put('src/a.ts', 'needle');
    put('node_modules/pkg/index.js', 'needle');
    put('dist/out.js', 'needle');
    put('.git/HEAD', 'needle');
    put('logs/run.log', 'needle');
    put('.gitignore', 'logs/\n');
    const result = await search({ query: 'needle' });
    expect(where(result)).toEqual(['src/a.ts:1:1']);
  });

  it('skips binary files and files over 2 MB, and does not count them as searched', async () => {
    put('text.txt', 'needle');
    put('image.bin', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
    put('big.txt', `needle${'x'.repeat(SEARCH_FILE_MAX_BYTES)}`);
    const result = await search({ query: 'needle' });
    expect(where(result)).toEqual(['text.txt:1:1']);
    expect(result.searchedFiles).toBe(1);
  });

  it('runs a regex, and honours match case and whole word', async () => {
    put('a.ts', 'fooBar foo_bar foobar Foo\n');
    expect(where(await search({ query: 'foo\\w+', regex: true }))).toEqual([
      'a.ts:1:1',
      'a.ts:1:8',
      'a.ts:1:16',
    ]);
    expect(where(await search({ query: 'Foo', matchCase: true }))).toEqual(['a.ts:1:23']);
    expect(where(await search({ query: 'foo', wholeWord: true }))).toEqual(['a.ts:1:23']);
    expect(where(await search({ query: 'foo', wholeWord: true, matchCase: true }))).toEqual([]);
  });

  it('treats regex characters literally unless regex is on', async () => {
    put('a.ts', 'a.b axb (x)\n');
    expect(where(await search({ query: 'a.b' }))).toEqual(['a.ts:1:1']);
    expect(where(await search({ query: '(x)' }))).toEqual(['a.ts:1:9']);
    expect(where(await search({ query: 'a.b', regex: true }))).toEqual(['a.ts:1:1', 'a.ts:1:5']);
  });

  it('keeps to the include globs and leaves out the exclude globs (comma-separated)', async () => {
    put('src/a.ts', 'needle');
    put('src/a.test.ts', 'needle');
    put('src/deep/b.tsx', 'needle');
    put('docs/readme.md', 'needle');
    put('root.ts', 'needle');
    expect(where(await search({ query: 'needle', include: 'src' })).sort()).toEqual([
      'src/a.test.ts:1:1',
      'src/a.ts:1:1',
      'src/deep/b.tsx:1:1',
    ]);
    expect(where(await search({ query: 'needle', include: '*.md, root.ts' })).sort()).toEqual([
      'docs/readme.md:1:1',
      'root.ts:1:1',
    ]);
    expect(
      where(await search({ query: 'needle', include: 'src', exclude: '*.test.ts, deep' })),
    ).toEqual(['src/a.ts:1:1']);
    expect(where(await search({ query: 'needle', exclude: 'src/**/*.tsx' })).sort()).toEqual([
      'docs/readme.md:1:1',
      'root.ts:1:1',
      'src/a.test.ts:1:1',
      'src/a.ts:1:1',
    ]);
  });

  it('stops at maxResults and says it was truncated; exactly maxResults is not truncated', async () => {
    put('a.ts', 'x x x\nx x\n');
    const cut = await search({ query: 'x', maxResults: 3 });
    expect(where(cut)).toEqual(['a.ts:1:1', 'a.ts:1:3', 'a.ts:1:5']);
    expect(cut.truncated).toBe(true);
    const exact = await search({ query: 'x', maxResults: 5 });
    expect(where(exact)).toHaveLength(5);
    expect(exact.truncated).toBe(false);
  });

  it('caps a preview at 240 characters around the match and trims leading indentation', async () => {
    const long = `${'a'.repeat(300)}needle${'b'.repeat(300)}`;
    put('long.txt', `      indented needle\n${long}\n`);
    const result = await search({ query: 'needle' });
    const [first, second] = result.files[0]?.matches ?? [];
    expect(first).toMatchObject({ line: 1, column: 16, preview: 'indented needle' });
    expect(first?.previewOffset).toBe(9);
    expect(second?.column).toBe(301);
    expect(second?.preview.length).toBeLessThanOrEqual(240);
    const offset = second?.previewOffset ?? -1;
    expect(second?.preview.slice(offset, offset + 6)).toBe('needle');
  });

  it('numbers CRLF lines as the editor does, and never loops on an empty match', async () => {
    put('a.ts', 'one\r\ntwo needle\r\nthree\r\n');
    expect(where(await search({ query: 'needle' }))).toEqual(['a.ts:2:5']);
    expect(where(await search({ query: '^', regex: true }))).toEqual([]);
    expect(where(await search({ query: 'x*', regex: true }))).toEqual([]);
  });

  it('refuses an invalid regex, a pattern over 1000 characters and nested repetition before reading', async () => {
    put('a.ts', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!');
    await expect(search({ query: '(a', regex: true })).rejects.toBeInstanceOf(ZodError);
    await expect(search({ query: 'a'.repeat(1001) })).rejects.toBeInstanceOf(ZodError);
    await expect(search({ query: '(a+)+$', regex: true })).rejects.toThrow(/too long/);
  });

  it('stops a file at its deadline and the whole search at its own, saying it was truncated', async () => {
    put('a.ts', Array.from({ length: 50 }, () => 'needle').join('\n'));
    put('b.ts', 'needle');
    let clock = 0;
    // every look at the clock is 10 ms later
    const now = (): number => (clock += 10);
    const perFile = await search({ query: 'needle' }, { now, fileDeadlineMs: 100 });
    const inA = perFile.files.find((file) => file.path === 'a.ts')?.matches.length ?? 0;
    expect(inA).toBeGreaterThan(0);
    expect(inA).toBeLessThan(50);
    expect(perFile.truncated).toBe(true);
    // b.ts still ran: the deadline is per file
    expect(where(perFile)).toContain('b.ts:1:1');

    clock = 0;
    const total = await search({ query: 'needle' }, { now, totalDeadlineMs: 50 });
    expect(total.truncated).toBe(true);
    expect(where(total)).not.toContain('b.ts:1:1');
  });

  it('marks the result truncated when the file walk itself was cut short', async () => {
    put('a.ts', 'needle');
    put('b.ts', 'needle');
    const result = await search({ query: 'needle' }, { listLimit: 1 });
    expect(result.searchedFiles).toBe(1);
    expect(result.truncated).toBe(true);
  });
});

/** Every 100 ms, the time: a blocked event loop shows as a gap. */
function watchEventLoop(): { stop(): number[] } {
  const ticks: number[] = [Date.now()];
  const timer = setInterval(() => ticks.push(Date.now()), 100);
  return {
    stop() {
      clearInterval(timer);
      ticks.push(Date.now());
      return ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? tick));
    },
  };
}

describe('D299 Phase 4 fix C1: a regex search runs in a worker with a hard deadline', () => {
  it('stops a catastrophic pattern at 5 s with what it found, and the event loop stays free', async () => {
    put('a.ts', 'a'.repeat(12));
    // 41 characters: (.*a){12}$ backtracks for minutes on this line
    put('b.ts', `${'a'.repeat(40)}!`);
    const loop = watchEventLoop();
    const started = Date.now();
    const result = await search({ query: '(.*a){12}$', regex: true });
    const elapsed = Date.now() - started;
    const gaps = loop.stop();

    expect(result.timedOut).toBe(true);
    expect(result.truncated).toBe(true);
    expect(where(result)).toEqual(['a.ts:1:1']);
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(6_500);
    expect(Math.max(...gaps)).toBeLessThan(1_000);
  }, 15_000);

  it('keeps the engine responsive while an alternation backtracks, and finishes it', async () => {
    put('a.ts', 'a'.repeat(24));
    const loop = watchEventLoop();
    const result = await search({ query: '(a|a)*b', regex: true });
    const gaps = loop.stop();
    expect(Math.max(...gaps)).toBeLessThan(1_000);
    // finished or stopped at the deadline on a loaded machine: either way, no match and no freeze
    expect(result.files).toEqual([]);
  }, 15_000);

  it('terminates the worker when the search is aborted, and answers with what it has', async () => {
    put('a.ts', 'ab');
    put('b.ts', 'a'.repeat(30));
    const controller = new AbortController();
    let worker: Worker | undefined;
    const started = Date.now();
    setTimeout(() => controller.abort(), 300);
    const result = await search(
      { query: '(a|a)*b', regex: true },
      { signal: controller.signal, onWorker: (created) => (worker = created) },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(where(result)).toEqual(['a.ts:1:1']);
    expect(worker).toBeDefined();
    // a terminated worker reports its exit; a live one never would
    expect(worker?.threadId).toBe(-1);
  }, 15_000);

  it('searches literal text in-thread, with no worker', async () => {
    put('a.ts', '(.*a){12}$');
    let workers = 0;
    const result = await search({ query: '(.*a){12}$' }, { onWorker: () => (workers += 1) });
    expect(where(result)).toEqual(['a.ts:1:1']);
    expect(workers).toBe(0);
  });

  it('stops before reading when the signal is already aborted', async () => {
    put('a.ts', 'needle');
    const controller = new AbortController();
    controller.abort();
    const result = await search({ query: 'needle' }, { signal: controller.signal });
    expect(result).toMatchObject({ files: [], truncated: true, searchedFiles: 0 });
  });
});
