import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StreamChunk } from '../../../adapter.js';
import {
  GEMINI_BASE_ARGS,
  createGeminiAdapter,
  createGeminiParser,
  geminiDialect,
  geminiError,
  geminiModelsFrom,
} from '../gemini.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-gemini-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RUN = [
  { type: 'init', session_id: 's', model: 'gemini-2.5-pro' },
  { type: 'message', role: 'user', content: 'p' },
  { type: 'message', role: 'assistant', content: 'Reading ', delta: true },
  { type: 'message', role: 'assistant', content: 'the file.', delta: true },
  { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { absolute_path: 'a.js' } },
  { type: 'tool_result', tool_id: 't1', status: 'success', output: 'export const add' },
  { type: 'message', role: 'assistant', content: 'Done.', delta: true },
  { type: 'result', status: 'success', stats: { total_tokens: 140, input_tokens: 120, output_tokens: 20 } },
];

function replay(events: object[], exitCode = 0): StreamChunk[] {
  const parser = createGeminiParser(() => 0);
  const chunks = events.flatMap((event) => parser.onEvent(event as Record<string, unknown>));
  return [...chunks, ...parser.finish({ code: exitCode, signal: null, stderrTail: '', killed: false })];
}

describe('X1 Gemini CLI flags', () => {
  const req = { modelId: 'pro', prompt: 'p', outputTypes: ['text' as const], system: 'S' };

  it.each([
    ['read_only', 'plan'],
    ['edit_files', 'auto_edit'],
    ['full_auto', 'yolo'],
  ] as const)('maps %s to --approval-mode %s', (permission, mode) => {
    expect(geminiDialect.args(req, permission)).toEqual([...GEMINI_BASE_ARGS, '--approval-mode', mode, '-m', 'pro']);
  });

  it('prompts on stdin with the system section first, and stops the self-relaunch', () => {
    expect(geminiDialect.stdin(req)).toBe('S\n\np');
    expect(geminiDialect.env?.({ PATH: 'x' })).toEqual({ PATH: 'x', GEMINI_CLI_NO_RELAUNCH: 'true' });
    expect([...GEMINI_BASE_ARGS]).toEqual(['-o', 'stream-json', '--skip-trust']);
  });
});

describe('X1 Gemini CLI stream', () => {
  it('streams assistant deltas, records tool use, reports usage with no cost', () => {
    const chunks = replay(RUN);
    expect(chunks.flatMap((c) => (c.type === 'text' ? [c.delta] : [])).join('')).toBe('Reading the file.\n\nDone.');
    expect(chunks.filter((c) => c.type === 'activity')).toEqual([
      { type: 'activity', tool: 'read_file', args: { absolute_path: 'a.js' }, status: 'ok', summary: 'export const add', durationMs: 0 },
    ]);
    expect(chunks.at(-2)).toEqual({ type: 'usage', tokensIn: 120, tokensOut: 20 });
  });

  it('maps its exit codes: 41 is a sign-in failure, 55 an untrusted folder', () => {
    expect(() => replay([], 41)).toThrow(/not signed in/);
    expect(() => replay([], 55)).toThrow(/trust/);
    expect(geminiError('Quota exceeded (429)')).toMatchObject({ code: 'http_429', retryable: true });
  });

  it('reads the turn limit (exit 53) as a final provider failure, never one a retry re-runs (review I4)', () => {
    expect(geminiError('turn limit', 53)).toMatchObject({ kind: 'provider', code: 'cli_max_turns', retryable: false });
  });

  it('a result with status error is an error', () => {
    expect(() => replay([{ type: 'result', status: 'error', error: { type: 'x', message: 'model not found' } }], 1)).toThrow(/model not found/);
  });
});

describe('X1 the Gemini adapter against a fake CLI', () => {
  it('runs with GEMINI_CLI_NO_RELAUNCH set', async () => {
    const echo = join(dir, 'echo.json');
    const adapter = createGeminiAdapter({
      permission: 'read_only',
      detect: async () => ({ type: 'gemini_cli', installed: true, login: 'unknown', installHint: 'i', loginHint: 'l' }),
      resolve: () => ({ command: process.execPath, prefixArgs: [FAKE], path: FAKE }),
      env: { ...process.env, FAKE_CLI_MODE: 'echo-stdin', FAKE_CLI_ECHO_FILE: echo },
    });
    const drained: StreamChunk[] = [];
    await (async () => {
      for await (const chunk of adapter.generate({ modelId: 'default', prompt: 'x', outputTypes: ['text'], workingDir: dir }, new AbortController().signal)) drained.push(chunk);
    })().catch(() => undefined);
    expect((JSON.parse(readFileSync(echo, 'utf8')) as { env: { GEMINI_CLI_NO_RELAUNCH: string } }).env.GEMINI_CLI_NO_RELAUNCH).toBe('true');
  });
});

describe('D286 Gemini CLI models come from the CLI’s own configuration, never a list kept in ACE', () => {
  it('offers the CLI’s default and the model its settings and environment name — nothing invented', () => {
    const models = geminiModelsFrom({
      settings: { model: { name: 'gemini-3.5-pro' } },
      env: { GEMINI_MODEL: 'gemini-3.5-flash' },
    });
    expect(models.map((model) => model.modelId)).toEqual(['default', 'gemini-3.5-pro', 'gemini-3.5-flash']);
    expect(models.every((model) => model.available !== false)).toBe(true);
    expect(models[0]?.description).toMatch(/configured/i);
  });

  it('reads the older settings shape and drops a repeat', () => {
    expect(
      geminiModelsFrom({ settings: { model: 'gemini-3.5-pro' }, env: { GEMINI_MODEL: 'gemini-3.5-pro' } }).map(
        (model) => model.modelId,
      ),
    ).toEqual(['default', 'gemini-3.5-pro']);
  });

  it('offers only the default when nothing is configured', () => {
    expect(geminiModelsFrom({ settings: undefined, env: {} }).map((model) => model.modelId)).toEqual(['default']);
  });

  it('says how to install a CLI that is not there instead of listing models for it', async () => {
    const failure = await geminiDialect.listModels(() => undefined).catch((error: unknown) => error);
    expect((failure as { nodeError?: { code?: string } }).nodeError?.code).toBe('cli_not_found');
  });

  it('reports the model the CLI says it is using', () => {
    const chunks = replay(RUN);
    expect(chunks).toContainEqual({ type: 'model', modelId: 'gemini-2.5-pro' });
  });
});
