import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StreamChunk } from '../../../adapter.js';
import { CODEX_BASE_ARGS, codexDialect, codexError, codexModelsFrom, createCodexAdapter, createCodexParser } from '../codex.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-codex-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The shape `codex exec --json` documents (spec §5.1). */
const RUN = [
  { type: 'thread.started', thread_id: 'th_1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'I will add multiply.' } },
  { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'node --test', status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'node --test', aggregated_output: '# pass 2\n# fail 0', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'src/math.js', kind: 'update' }], status: 'completed' } },
  { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Done: tests pass.' } },
  { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90, reasoning_output_tokens: 40 } },
];

function replay(events: object[]): StreamChunk[] {
  const parser = createCodexParser(() => 0);
  const chunks = events.flatMap((event) => parser.onEvent(event as Record<string, unknown>));
  return [...chunks, ...parser.finish({ code: 0, signal: null, stderrTail: '', killed: false })];
}

describe('X1 Codex CLI flags', () => {
  const req = { modelId: 'gpt-6.1-sol', prompt: 'p', outputTypes: ['text' as const], system: 'S' };

  it.each([
    ['read_only', ['--sandbox', 'read-only']],
    ['edit_files', ['--sandbox', 'workspace-write']],
    // D355: an old full_auto row runs as edit_files — the sandbox is never bypassed.
    ['full_auto', ['--sandbox', 'workspace-write']],
  ] as const)('maps %s, reads the prompt from stdin', (permission, flags) => {
    expect(codexDialect.args(req, permission)).toEqual([...CODEX_BASE_ARGS, ...flags, '-m', 'gpt-6.1-sol', '-']);
  });

  it('puts ACE’s system section before the prompt, and leaves "default" to the CLI', () => {
    expect(codexDialect.stdin(req)).toBe('S\n\np');
    expect(codexDialect.args({ ...req, modelId: 'default' }, 'read_only')).not.toContain('-m');
    expect([...CODEX_BASE_ARGS]).toEqual(['exec', '--json', '--skip-git-repo-check', '--color', 'never']);
  });
});

describe('X1 Codex CLI stream', () => {
  it('turns messages into text, commands and edits into activity, and reports no usage (D313)', () => {
    const chunks = replay(RUN);
    expect(chunks.flatMap((c) => (c.type === 'text' ? [c.delta] : [])).join('')).toBe('I will add multiply.\n\nDone: tests pass.');
    expect(chunks.filter((c) => c.type === 'activity')).toEqual([
      { type: 'activity', tool: 'command', args: { command: 'node --test' }, status: 'ok', summary: '# pass 2 # fail 0', durationMs: 0 },
      { type: 'activity', tool: 'file_change', args: { changes: [{ path: 'src/math.js', kind: 'update' }] }, status: 'ok', summary: 'update src/math.js', durationMs: 0 },
    ]);
    // Codex is estimated-only until its real output is captured: no field name is trusted, so the
    // executor estimates the turn (D313).
    expect(chunks.some((c) => c.type === 'usage')).toBe(false);
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('marks a failed command as an error', () => {
    const chunks = replay([
      { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'npm test', aggregated_output: 'boom', exit_code: 1, status: 'failed' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(chunks[0]).toMatchObject({ type: 'activity', status: 'error' });
  });

  it('a failed turn is an error, mapped by what it says', () => {
    const parser = createCodexParser(() => 0);
    parser.onEvent({ type: 'turn.failed', error: { message: 'You exceeded your usage limit (429)' } });
    expect(() => parser.finish({ code: 1, signal: null, stderrTail: '', killed: false })).toThrow(/usage limit/);
    expect(codexError('Not logged in')).toMatchObject({ kind: 'auth', code: 'cli_not_signed_in' });
    expect(codexError('rate limit 429')).toMatchObject({ code: 'http_429', retryable: true });
    expect(codexError('model not found')).toMatchObject({ kind: 'provider', code: 'cli_turn_failed', retryable: false });
  });
});

describe('X1 Codex model list', () => {
  it('reads ids from `codex debug models` JSON, tolerating shapes', () => {
    expect(codexModelsFrom('{"models":[{"slug":"gpt-6.1-sol"},{"id":"gpt-6-luna"}]}')).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(codexModelsFrom('["a","b"]')).toEqual(['a', 'b']);
    expect(codexModelsFrom('not json')).toEqual([]);
  });
});

describe('X1 the Codex adapter against a fake CLI', () => {
  it('replays a run', async () => {
    const file = join(dir, 'run.jsonl');
    writeFileSync(file, RUN.map((e) => JSON.stringify(e)).join('\n'));
    const adapter = createCodexAdapter({
      permission: 'edit_files',
      detect: async () => ({ type: 'codex_cli', installed: true, login: 'logged_in', installHint: 'i', loginHint: 'l' }),
      resolve: () => ({ command: process.execPath, prefixArgs: [FAKE], path: FAKE }),
      env: { ...process.env, FAKE_CLI_MODE: 'replay', FAKE_CLI_FILE: file },
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.generate({ modelId: 'default', prompt: 'x', outputTypes: ['text'], workingDir: dir }, new AbortController().signal)) {
      chunks.push(chunk);
    }
    expect(chunks.filter((c) => c.type === 'activity')).toHaveLength(2);
  });
});

describe('D286 Codex CLI models', () => {
  it('says how to install a CLI that is not there instead of offering its default', async () => {
    const failure = await codexDialect.listModels(() => undefined).catch((error: unknown) => error);
    expect((failure as { nodeError?: { code?: string } }).nodeError?.code).toBe('cli_not_found');
  });
});
