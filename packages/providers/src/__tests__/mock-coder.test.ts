import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProviderCallError, type GenerateRequest, type StreamChunk } from '../adapter.js';
import {
  MOCK_CODER_NO_FOLDER,
  mockCoderAnswer,
  mockCoderPieces,
  parseCoderDirectives,
  resolveInside,
} from '../adapters/mock-coder.js';
import { MOCK_MODELS, countWords, createMockAdapter } from '../adapters/mock.js';

/**
 * P0 §7 `mock-coder`: directives in the prompt become file edits in the call's `workingDir`, each
 * reported as an `activity` chunk the executor logs as a `cli_<tool>` ToolCall.
 */

type Activity = Extract<StreamChunk, { type: 'activity' }>;

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

const textChunksOf = (chunks: StreamChunk[]): string[] =>
  chunks
    .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
    .map((c) => c.delta);

const textOf = (chunks: StreamChunk[]): string => textChunksOf(chunks).join('');

const activitiesOf = (chunks: StreamChunk[]): Activity[] =>
  chunks.filter((c): c is Activity => c.type === 'activity');

/** The input as the prompt manager embeds it: a `## Input` section among the others. */
const prompt = (...input: string[]): string =>
  [
    '## System',
    'You are a node.',
    '',
    '## Input',
    ...input,
    '',
    '## Output contract',
    'text',
    '',
  ].join('\n');

/** A clock that moves 5 ms each time it is read, so every directive takes exactly 5 ms. */
function steppingClock(): () => number {
  let at = 0;
  return () => (at += 5);
}

const mockAdapter = () => createMockAdapter({ sleep: async () => {}, now: steppingClock() });

const run = (text: string, extra: Partial<GenerateRequest> = {}, signal?: AbortSignal) =>
  collect(
    mockAdapter().generate(
      { modelId: 'mock-coder', prompt: text, outputTypes: ['text'], ...extra },
      signal ?? new AbortController().signal,
    ),
  );

let base: string;
let work: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ace-mock-coder-'));
  work = join(base, 'work');
  await mkdir(work);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const read = (path: string): Promise<string> => readFile(join(work, path), 'utf8');

describe('P0 §7 mock-coder is catalogued', () => {
  it('is listed once as a text → text model called Mock coder', async () => {
    const found = MOCK_MODELS.filter((model) => model.modelId === 'mock-coder');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      displayName: 'Mock coder',
      inputTypes: ['text'],
      outputTypes: ['text'],
      supportsTools: false,
    });
    const listed = await createMockAdapter().listModels();
    expect(listed.map((model) => model.modelId)).toContain('mock-coder');
  });
});

describe('P0 §7 mock-coder edits files in its working folder', () => {
  it('writes nested files verbatim, with a trailing newline, and reports each as activity', async () => {
    const chunks = await run(
      prompt(
        'Please make these changes.',
        '  ace-mock:write src/deep/notes file.txt',
        '  indented line',
        'ace-mock:delete looks like a directive but is content',
        '',
        'last line  ',
        'ace-mock:end',
        'ace-mock:write top.md',
        '# Title',
        '    ace-mock:end',
      ),
      { workingDir: work },
    );

    expect(await read('src/deep/notes file.txt')).toBe(
      '  indented line\nace-mock:delete looks like a directive but is content\n\nlast line  \n',
    );
    expect(await read('top.md')).toBe('# Title\n');

    expect(activitiesOf(chunks)).toEqual([
      {
        type: 'activity',
        tool: 'write_file',
        args: { path: 'src/deep/notes file.txt' },
        status: 'ok',
        summary: expect.stringMatching(/^wrote \d+ bytes$/),
        durationMs: 5,
      },
      {
        type: 'activity',
        tool: 'write_file',
        args: { path: 'top.md' },
        status: 'ok',
        summary: 'wrote 8 bytes',
        durationMs: 5,
      },
    ]);
    expect(textOf(chunks)).toBe('Changed 2 file(s):\n- src/deep/notes file.txt\n- top.md');
  });

  it('overwrites a file that is already there', async () => {
    await writeFile(join(work, 'a.txt'), 'old content that is longer\n');

    const chunks = await run(prompt('ace-mock:write a.txt', 'new', 'ace-mock:end'), {
      workingDir: work,
    });

    expect(await read('a.txt')).toBe('new\n');
    expect(activitiesOf(chunks)[0]).toMatchObject({ status: 'ok', tool: 'write_file' });
  });

  it('writes an empty file for a block with no lines', async () => {
    await run(prompt('ace-mock:write empty.txt', 'ace-mock:end'), { workingDir: work });

    expect(await read('empty.txt')).toBe('');
  });

  it('reads Windows line endings and re-applies the same directives idempotently', async () => {
    const text = prompt('ace-mock:write crlf.txt', 'one', 'two', 'ace-mock:end').replace(
      /\n/g,
      '\r\n',
    );

    await run(text, { workingDir: work });
    const again = await run(text, { workingDir: work });

    expect(await read('crlf.txt')).toBe('one\ntwo\n');
    expect(textOf(again)).toBe('Changed 1 file(s):\n- crlf.txt');
  });

  it('deletes a file, and reports a missing one as not found', async () => {
    await mkdir(join(work, 'old'), { recursive: true });
    await writeFile(join(work, 'old', 'gone.txt'), 'bye\n');

    const chunks = await run(
      prompt('ace-mock:delete old/gone.txt', 'ace-mock:delete never-was.txt'),
      {
        workingDir: work,
      },
    );

    expect(existsSync(join(work, 'old', 'gone.txt'))).toBe(false);
    expect(activitiesOf(chunks)).toEqual([
      {
        type: 'activity',
        tool: 'delete_file',
        args: { path: 'old/gone.txt' },
        status: 'ok',
        summary: 'deleted',
        durationMs: 5,
      },
      {
        type: 'activity',
        tool: 'delete_file',
        args: { path: 'never-was.txt' },
        status: 'error',
        summary: 'not found',
        durationMs: 5,
      },
    ]);
    expect(textOf(chunks)).toBe('Changed 1 file(s):\n- old/gone.txt');
  });

  it('lists a file once when it changed more than once, under its normalised path', async () => {
    const chunks = await run(
      prompt(
        'ace-mock:write dir/../same.txt',
        'first',
        'ace-mock:end',
        'ace-mock:write same.txt',
        'second',
        'ace-mock:end',
        'ace-mock:delete same.txt',
      ),
      { workingDir: work },
    );

    expect(existsSync(join(work, 'same.txt'))).toBe(false);
    expect(activitiesOf(chunks).map((a) => a.status)).toEqual(['ok', 'ok', 'ok']);
    expect(textOf(chunks)).toBe('Changed 1 file(s):\n- same.txt');
  });

  it('refuses a folder as a file, for a delete and for a write', async () => {
    await mkdir(join(work, 'folder'));

    const chunks = await run(
      prompt('ace-mock:delete folder', 'ace-mock:write folder', 'x', 'ace-mock:end'),
      { workingDir: work },
    );

    expect(activitiesOf(chunks)).toEqual([
      expect.objectContaining({
        tool: 'delete_file',
        status: 'error',
        summary: 'is a folder, not a file',
      }),
      expect.objectContaining({ tool: 'write_file', status: 'error' }),
    ]);
    expect(existsSync(join(work, 'folder'))).toBe(true);
    expect(textOf(chunks)).toBe('Changed 0 file(s).');
  });

  it('reports a failed write through a file used as a folder', async () => {
    await writeFile(join(work, 'plain.txt'), 'x\n');

    const chunks = await run(prompt('ace-mock:write plain.txt/inner.txt', 'y', 'ace-mock:end'), {
      workingDir: work,
    });

    expect(activitiesOf(chunks)[0]).toMatchObject({
      status: 'error',
      summary: expect.stringMatching(/^failed/),
    });
  });

  it('refuses an unterminated write and writes nothing', async () => {
    const chunks = await run(prompt('ace-mock:write open.txt', 'never closed'), {
      workingDir: work,
    });

    expect(existsSync(join(work, 'open.txt'))).toBe(false);
    expect(activitiesOf(chunks)).toEqual([
      expect.objectContaining({ status: 'error', summary: 'missing ace-mock:end' }),
    ]);
  });

  it('reads directives from the system text too, before the prompt', async () => {
    const chunks = await run(prompt('ace-mock:write b.txt', 'B', 'ace-mock:end'), {
      workingDir: work,
      system: 'ace-mock:write a.txt\nA\nace-mock:end',
    });

    expect(await read('a.txt')).toBe('A\n');
    expect(textOf(chunks)).toBe('Changed 2 file(s):\n- a.txt\n- b.txt');
  });
});

describe('P0 §7 mock-coder never writes outside its working folder', () => {
  it('refuses ../escape.txt and leaves nothing outside', async () => {
    const chunks = await run(prompt('ace-mock:write ../escape.txt', 'out', 'ace-mock:end'), {
      workingDir: work,
    });

    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
    expect(activitiesOf(chunks)).toEqual([
      {
        type: 'activity',
        tool: 'write_file',
        args: { path: '../escape.txt' },
        status: 'error',
        summary: 'outside the working folder',
        durationMs: 5,
      },
    ]);
    expect(textOf(chunks)).toBe('Changed 0 file(s).');
  });

  it('refuses an absolute path', async () => {
    const absolute = `${base.replace(/\\/g, '/')}/abs.txt`;

    const chunks = await run(
      prompt(`ace-mock:write ${absolute}`, 'x', 'ace-mock:end', 'ace-mock:delete /etc/hosts'),
      { workingDir: work },
    );

    expect(existsSync(join(base, 'abs.txt'))).toBe(false);
    expect(activitiesOf(chunks).map((a) => [a.status, a.summary])).toEqual([
      ['error', 'absolute path refused'],
      ['error', 'absolute path refused'],
    ]);
  });

  it('refuses a delete that escapes, and the file outside survives', async () => {
    await writeFile(join(base, 'keep.txt'), 'keep\n');

    const chunks = await run(prompt('ace-mock:delete sub/../../keep.txt'), { workingDir: work });

    expect(existsSync(join(base, 'keep.txt'))).toBe(true);
    expect(activitiesOf(chunks)[0]).toMatchObject({
      tool: 'delete_file',
      status: 'error',
      summary: 'outside the working folder',
    });
  });

  it('refuses a write through a link that points outside', async (context) => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    try {
      // A junction on Windows needs no extra privilege; elsewhere the type is ignored.
      await symlink(outside, join(work, 'link'), 'junction');
    } catch {
      context.skip();
    }

    const chunks = await run(
      prompt(
        'ace-mock:write link/x.txt',
        'x',
        'ace-mock:end',
        'ace-mock:write link/sub/y.txt',
        'y',
        'ace-mock:end',
      ),
      { workingDir: work },
    );

    expect(existsSync(join(outside, 'x.txt'))).toBe(false);
    expect(existsSync(join(outside, 'sub'))).toBe(false);
    expect(activitiesOf(chunks).map((a) => a.summary)).toEqual([
      'outside the working folder',
      'outside the working folder',
    ]);
  });

  it('refuses empty, backslash and folder-root paths', async () => {
    expect(await resolveInside(work, '')).toEqual({ ok: false, reason: 'no path given' });
    expect(await resolveInside(work, 'a\\b.txt')).toEqual({
      ok: false,
      reason: 'paths use /, not \\',
    });
    expect(await resolveInside(work, 'C:/x.txt')).toEqual({
      ok: false,
      reason: 'absolute path refused',
    });
    expect(await resolveInside(work, '.')).toEqual({ ok: false, reason: 'not a file path' });
    expect(await resolveInside(work, 'a/..')).toEqual({ ok: false, reason: 'not a file path' });
    expect(await resolveInside(work, 'a//b.txt')).toMatchObject({ ok: true, relative: 'a/b.txt' });
  });
});

describe('P0 §7 mock-coder answers', () => {
  it('without a working folder: changes nothing, reports no activity, says so', async () => {
    const chunks = await run(prompt('ace-mock:write a.txt', 'A', 'ace-mock:end'));

    expect(activitiesOf(chunks)).toEqual([]);
    expect(textOf(chunks)).toBe(MOCK_CODER_NO_FOLDER);
    expect(MOCK_CODER_NO_FOLDER).toBe('mock-coder has no working folder; nothing was changed.');
  });

  it('with nothing to do: No changes requested.', async () => {
    const chunks = await run(prompt('Just look around.'), { workingDir: work });

    expect(activitiesOf(chunks)).toEqual([]);
    expect(textOf(chunks)).toBe('No changes requested.');
  });

  it('streams the answer word by word, then usage and finish like mock-text', async () => {
    const text = prompt(
      'ace-mock:write a.txt',
      'A',
      'ace-mock:end',
      'ace-mock:write b/c.txt',
      'C',
      'ace-mock:end',
    );
    const chunks = await run(text, { workingDir: work });

    const answer = 'Changed 2 file(s):\n- a.txt\n- b/c.txt';
    expect(textChunksOf(chunks)).toEqual(mockCoderPieces(answer));
    expect(textChunksOf(chunks).length).toBeGreaterThan(1);
    expect(textOf(chunks)).toBe(answer);
    expect(chunks.slice(-2)).toEqual([
      { type: 'usage', tokensIn: countWords(text), tokensOut: countWords(answer) },
      { type: 'finish', reason: 'stop' },
    ]);
    // Activity first, then the answer: the edits are done before the model "speaks".
    const types = chunks.map((c) => c.type);
    expect(types.indexOf('text')).toBeGreaterThan(types.lastIndexOf('activity'));
  });

  it('builds the answer from what changed', () => {
    expect(mockCoderAnswer([], 0)).toBe('No changes requested.');
    expect(mockCoderAnswer([], 2)).toBe('Changed 0 file(s).');
    expect(mockCoderAnswer(['a', 'b c'], 2)).toBe('Changed 2 file(s):\n- a\n- b c');
    expect(mockCoderPieces('a b\n- c').join('')).toBe('a b\n- c');
  });

  it('answers a project folder that is gone with invalid_config, like the CLI adapters', async () => {
    await expect(
      run(prompt('ace-mock:write a.txt', 'A', 'ace-mock:end'), {
        workingDir: join(base, 'missing'),
      }),
    ).rejects.toMatchObject({
      nodeError: { kind: 'invalid_config', code: 'project_folder_missing', retryable: false },
    });
  });
});

describe('P0 §7 ace-mock:fail', () => {
  it('ends the call with a non-retryable provider error carrying the message', async () => {
    const error = await run(prompt('ace-mock:fail   the build is broken  '), {
      workingDir: work,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderCallError);
    expect((error as ProviderCallError).nodeError).toEqual({
      kind: 'provider',
      code: 'mock_coder_failed',
      message: 'the build is broken',
      retryable: false,
    });
  });

  it('keeps what was done before it and does nothing after it', async () => {
    const adapter = mockAdapter();
    const seen: StreamChunk[] = [];
    const call = (async () => {
      for await (const chunk of adapter.generate(
        {
          modelId: 'mock-coder',
          prompt: prompt(
            'ace-mock:write before.txt',
            'B',
            'ace-mock:end',
            'ace-mock:fail',
            'ace-mock:write after.txt',
            'A',
            'ace-mock:end',
          ),
          outputTypes: ['text'],
          workingDir: work,
        },
        new AbortController().signal,
      )) {
        seen.push(chunk);
      }
    })();

    await expect(call).rejects.toMatchObject({
      nodeError: { kind: 'provider', message: 'mock-coder was told to fail.', retryable: false },
    });
    expect(await read('before.txt')).toBe('B\n');
    expect(existsSync(join(work, 'after.txt'))).toBe(false);
    expect(activitiesOf(seen)).toHaveLength(1);
    expect(textOf(seen)).toBe('');
    expect(adapter.calls()[0]).toMatchObject({ modelId: 'mock-coder', failed: true });
  });

  it('fails without a working folder too', async () => {
    await expect(run(prompt('ace-mock:fail no folder'))).rejects.toMatchObject({
      nodeError: { kind: 'provider', code: 'mock_coder_failed', message: 'no folder' },
    });
  });
});

describe('P0 §7 mock-coder honours the abort signal', () => {
  it('does nothing at all when the call is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      run(
        prompt('ace-mock:write a.txt', 'A', 'ace-mock:end'),
        { workingDir: work },
        controller.signal,
      ),
    ).rejects.toMatchObject({ nodeError: { kind: 'user_cancelled', retryable: false } });
    expect(existsSync(join(work, 'a.txt'))).toBe(false);
  });

  it('stops streaming the answer the moment the call is cancelled', async () => {
    const controller = new AbortController();
    const adapter = createMockAdapter({
      sleep: async () => {
        controller.abort();
      },
    });
    const seen: StreamChunk[] = [];
    const call = (async () => {
      for await (const chunk of adapter.generate(
        {
          modelId: 'mock-coder',
          prompt: prompt('ace-mock:write a.txt', 'A', 'ace-mock:end'),
          outputTypes: ['text'],
          workingDir: work,
        },
        controller.signal,
      )) {
        seen.push(chunk);
      }
    })();

    await expect(call).rejects.toMatchObject({ nodeError: { kind: 'user_cancelled' } });
    expect(activitiesOf(seen)).toHaveLength(1);
    expect(seen.some((chunk) => chunk.type === 'finish')).toBe(false);
  });

  it('reads a timeout abort as a retryable network failure, like every mock model', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('slow', 'TimeoutError'));

    await expect(
      run(prompt('anything'), { workingDir: work }, controller.signal),
    ).rejects.toMatchObject({
      nodeError: { kind: 'network', retryable: true },
    });
  });
});

describe('P0 §7 directive parsing', () => {
  it('ignores a stray end, unknown words, and keywords that merely start a longer word', () => {
    expect(
      parseCoderDirectives(
        [
          'ace-mock:end',
          'ace-mock:frobnicate x',
          'ace-mock:endless',
          'ace-mock:deleted x',
          'say ace-mock:delete x mid-line',
          '\tace-mock:delete  spaced name.txt  ',
        ].join('\n'),
      ),
    ).toEqual([{ kind: 'delete', path: 'spaced name.txt' }]);
  });

  it('stops at an unterminated write, which swallows the rest as content', () => {
    expect(parseCoderDirectives('ace-mock:write a.txt\nace-mock:delete b.txt')).toEqual([
      { kind: 'write', path: 'a.txt', lines: [], closed: false },
    ]);
  });
});
