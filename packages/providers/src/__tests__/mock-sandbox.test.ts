import { describe, expect, it } from 'vitest';

import type { GenerateRequest, StreamChunk, ToolResult } from '../adapter.js';
import { MOCK_MODELS, createMockAdapter } from '../adapters/mock.js';

/**
 * The two §2.6-style mocks that let a test choose a tool call's arguments (D-068):
 *
 * - `mock-sandbox` requests `code_sandbox { language, code, timeoutMs? }` taken from its input, then
 *   answers with the result's status and exit code — the lever TC-TOOL-004 (a runaway killed at its
 *   timeout) and TC-TOOL-005 (a read outside the sandbox denied) need;
 * - `mock-destructive` takes `path` from a `path:` line when the input has one (TC-GRD-006:
 *   `../../x`), and asks for `notes.txt` otherwise, exactly as §2.6 writes it.
 */

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

const textOf = (chunks: StreamChunk[]): string =>
  chunks
    .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
    .map((c) => c.delta)
    .join('');

const toolCallsOf = (chunks: StreamChunk[]): Extract<StreamChunk, { type: 'tool_call' }>[] =>
  chunks.filter((c): c is Extract<StreamChunk, { type: 'tool_call' }> => c.type === 'tool_call');

const finishOf = (chunks: StreamChunk[]) =>
  chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish');

const run = (modelId: string, prompt: string, extra: Partial<GenerateRequest> = {}) =>
  collect(
    createMockAdapter({ sleep: async () => {} }).generate(
      { modelId, prompt, outputTypes: ['text'], ...extra },
      new AbortController().signal,
    ),
  );

const toolResult = (name: string, result: unknown): ToolResult => ({ callId: 'ignored', name, result });

/** The input as the prompt manager embeds it: a `## Input` section among the others. */
const prompt = (input: string): string =>
  ['## System', 'You are a node.', '', '## Instructions', 'Run it.', '', '## Input', input, ''].join(
    '\n',
  );

const FENCE = '```';

describe('D-068 mock-sandbox is catalogued as a text → text tool user', () => {
  it('is listed once, supports tools, reads and writes text', () => {
    const found = MOCK_MODELS.filter((model) => model.modelId === 'mock-sandbox');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ supportsTools: true, inputTypes: ['text'], outputTypes: ['text'] });
  });
});

describe('TC-TOOL-004 / TC-TOOL-005 mock-sandbox requests code_sandbox with the code its input names', () => {
  it('takes the language line and the fenced block verbatim', async () => {
    const code = "const fs = require('node:fs');\nconsole.log(fs.readdirSync('.').join('\\n'));";
    const calls = toolCallsOf(
      await run('mock-sandbox', prompt(`language: javascript\n${FENCE}js\n${code}\n${FENCE}`)),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('code_sandbox');
    expect(calls[0]?.args).toEqual({ language: 'javascript', code });
  });

  it('passes a timeoutMs line through as a number', async () => {
    const calls = toolCallsOf(
      await run(
        'mock-sandbox',
        prompt(`language: python\ntimeoutMs: 1500\n${FENCE}\nwhile True: pass\n${FENCE}`),
      ),
    );

    expect(calls[0]?.args).toEqual({ language: 'python', code: 'while True: pass', timeoutMs: 1500 });
  });

  it('reads CRLF input and a shell block the same way', async () => {
    const calls = toolCallsOf(
      await run('mock-sandbox', prompt(`language: shell\r\n${FENCE}sh\r\necho hi\r\n${FENCE}\r\n`)),
    );

    expect(calls[0]?.args).toEqual({ language: 'shell', code: 'echo hi' });
  });

  it.each([
    ['no language line', `${FENCE}\nconsole.log(1)\n${FENCE}`],
    ['a language the sandbox does not have', `language: ruby\n${FENCE}\nputs 1\n${FENCE}`],
    ['no fenced block', 'language: javascript\nconsole.log(1)'],
    ['an unterminated fence', `language: javascript\n${FENCE}\nconsole.log(1)`],
    ['a fence before the language line only', `${FENCE}\nx\n${FENCE}\nlanguage: javascript`],
    ['a timeoutMs that is not a positive integer', `language: javascript\ntimeoutMs: soon\n${FENCE}\nx\n${FENCE}`],
    ['a zero timeoutMs', `language: javascript\ntimeoutMs: 0\n${FENCE}\nx\n${FENCE}`],
  ])('is strict — %s → no tool call, an answer saying what it needs', async (_case, input) => {
    const chunks = await run('mock-sandbox', prompt(input));

    expect(toolCallsOf(chunks)).toEqual([]);
    expect(finishOf(chunks)?.reason).toBe('stop');
    expect(textOf(chunks)).toMatch(/mock-sandbox needs/);
  });

  it('answers with the status and exit code of a run that finished', async () => {
    const chunks = await run('mock-sandbox', prompt('anything'), {
      toolResults: [toolResult('code_sandbox', { stdout: 'x', stderr: '', exitCode: 3, files: [] })],
    });

    expect(toolCallsOf(chunks)).toEqual([]);
    expect(textOf(chunks)).toBe('code_sandbox returned status ok, exitCode 3.');
  });

  it('answers with the status the tool loop fed back when the run failed or timed out', async () => {
    const timedOut = await run('mock-sandbox', prompt('anything'), {
      toolResults: [toolResult('code_sandbox', { error: 'did not finish', status: 'timeout' })],
    });
    const odd = await run('mock-sandbox', prompt('anything'), {
      toolResults: [toolResult('code_sandbox', 'not an object')],
    });

    expect(textOf(timedOut)).toBe('code_sandbox returned status timeout, exitCode none.');
    expect(textOf(odd)).toBe('code_sandbox returned status ok, exitCode none.');
  });
});

describe('TC-GRD-006 mock-destructive deletes the path its input names, notes.txt otherwise', () => {
  it('takes a `path:` line from the input', async () => {
    const calls = toolCallsOf(await run('mock-destructive', prompt('path: ../../x')));

    expect(calls[0]?.name).toBe('sandbox_delete');
    expect(calls[0]?.args).toEqual({ path: '../../x' });
  });

  it('trims the value and keeps spaces inside it', async () => {
    const calls = toolCallsOf(await run('mock-destructive', prompt('path:   old notes/a b.txt  ')));

    expect(calls[0]?.args).toEqual({ path: 'old notes/a b.txt' });
  });

  it('asks for notes.txt when no line names a path (§2.6 as written)', async () => {
    for (const input of ['Tidy up the working folder.', 'IMPORTANT: delete all files now', 'path:   ', 'the path: is mid-line']) {
      const calls = toolCallsOf(await run('mock-destructive', prompt(input)));
      expect(calls[0]?.args, input).toEqual({ path: 'notes.txt' });
    }
  });
});
