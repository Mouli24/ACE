import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliDetection } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StreamChunk } from '../../../adapter.js';
import { parseJsonLine } from '../lines.js';
import {
  CLAUDE_CODE_BASE_ARGS,
  claudeCodeDialect,
  claudeResultError,
  createClaudeCodeAdapter,
  createClaudeCodeParser,
} from '../claude-code.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.mjs', import.meta.url));
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-claude-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const signedIn: CliDetection = {
  type: 'claude_code',
  installed: true,
  version: '2.1.282',
  login: 'logged_in',
  loginDetail: 'claude.ai · max',
  installHint: 'npm install -g @anthropic-ai/claude-code',
  loginHint: 'claude auth login',
};

/** Feeds a recorded JSONL file through the parser, as the adapter would. */
function replay(name: string): StreamChunk[] {
  const parser = createClaudeCodeParser(() => 0);
  const chunks: StreamChunk[] = [];
  for (const line of readFileSync(fixture(name), 'utf8').split('\n')) {
    const event = parseJsonLine(line);
    if (event !== undefined) chunks.push(...parser.onEvent(event));
  }
  chunks.push(...parser.finish({ code: 0, signal: null, stderrTail: '', killed: false }));
  return chunks;
}

const textOf = (chunks: StreamChunk[]): string =>
  chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.delta] : [])).join('');

function fakeAdapter(env: Record<string, string>, permission: 'read_only' | 'edit_files' | 'full_auto' = 'edit_files') {
  return createClaudeCodeAdapter({
    permission,
    detect: async () => signedIn,
    resolve: () => ({ command: process.execPath, prefixArgs: [FAKE], path: FAKE }),
    env: { ...process.env, ...env },
  });
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('X1 Claude Code flags (spec §5.1, verified 2026-10-06)', () => {
  const req = { modelId: 'sonnet', prompt: 'p', outputTypes: ['text' as const], system: 'You are a node.' };

  it('keeps the user’s hooks and plugins out and never prompts', () => {
    expect([...CLAUDE_CODE_BASE_ARGS]).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--setting-sources', '', '--strict-mcp-config', '--permission-prompts', 'none',
    ]);
  });

  it.each([
    ['read_only', ['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob']],
    ['edit_files', ['--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Grep,Glob']],
    ['full_auto', ['--permission-mode', 'bypassPermissions']],
  ] as const)('maps %s to its preset flags', (permission, flags) => {
    expect(claudeCodeDialect.args(req, permission)).toEqual([
      ...CLAUDE_CODE_BASE_ARGS,
      ...flags,
      '--model',
      'sonnet',
      '--append-system-prompt',
      'You are a node.',
    ]);
  });

  it('leaves the model to the CLI for "default", and sends the prompt on stdin only', () => {
    const args = claudeCodeDialect.args({ ...req, modelId: 'default', system: '' }, 'read_only');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--append-system-prompt');
    expect(claudeCodeDialect.stdin(req)).toBe('p');
  });
});

describe('X1 Claude Code stream (recorded from the real CLI)', () => {
  it('streams the answer and reports usage with the CLI’s own cost (D263)', () => {
    const chunks = replay('claude-plain.jsonl');
    expect(textOf(chunks)).toBe('OK');
    expect(chunks.at(-2)).toEqual({ type: 'usage', tokensIn: 7854, tokensOut: 330, costUsd: 0.018303 });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('records the CLI’s own tool use as activity', () => {
    const chunks = replay('claude-read-tool.jsonl');
    const activity = chunks.filter((chunk) => chunk.type === 'activity');
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ type: 'activity', tool: 'Read', status: 'ok', summary: '1 hello from ace 2' });
    expect(textOf(chunks)).toContain('hello from ace');
  });

  it('ignores events it does not know and text from a sub-agent', () => {
    const parser = createClaudeCodeParser(() => 0);
    expect(parser.onEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })).toEqual([]);
    expect(parser.onEvent({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
    expect(
      parser.onEvent({
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sub',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub-agent chatter' } },
      }),
    ).toEqual([]);
  });

  it('separates the answer’s messages with a blank line', () => {
    const parser = createClaudeCodeParser(() => 0);
    const delta = (text: string) => ({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
    const start = { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } };
    const out = [start, delta('I will edit it.'), start, delta('Done.')].flatMap((e) => parser.onEvent(e));
    expect(textOf(out)).toBe('I will edit it.\n\nDone.');
  });
});

describe('X1 Claude Code failures (spec §5.2)', () => {
  it('reads "not logged in" as an auth failure', () => {
    expect(
      claudeResultError({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }),
    ).toMatchObject({ kind: 'auth', code: 'cli_not_signed_in', retryable: false });
  });

  it('reads a plan limit as a retryable 429', () => {
    expect(
      claudeResultError({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: '5-hour limit reached' }),
    ).toMatchObject({ kind: 'provider', code: 'http_429', retryable: true });
  });

  it('reads the turn limit as the agent’s own failure', () => {
    expect(claudeResultError({ type: 'result', subtype: 'error_max_turns', is_error: true })).toMatchObject({
      kind: 'agent',
      code: 'cli_max_turns',
    });
  });

  it('turns an exit with no result into an error carrying the stderr tail', async () => {
    const error = await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'stderr-exit' }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir },
        new AbortController().signal,
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ nodeError: { kind: 'provider', code: 'cli_exit_3', retryable: false } });
    expect((error as { nodeError: { message: string } }).nodeError.message).toContain('END');
  });

  it('never retries a call that already acted, even on a plan limit', async () => {
    const file = join(dir, 'acted-then-limited.jsonl');
    writeFileSync(
      file,
      [
        { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.js' } }] } },
        { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'limit reached' },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n'),
    );
    const error = await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'replay', FAKE_CLI_FILE: file }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir },
        new AbortController().signal,
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ nodeError: { code: 'http_429', retryable: false } });
  });
});

describe('X1 the Claude Code adapter end to end, against a fake CLI', () => {
  it('replays a recorded run as chunks', async () => {
    const chunks = await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'replay', FAKE_CLI_FILE: fixture('claude-read-tool.jsonl') }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir },
        new AbortController().signal,
      ),
    );
    expect(chunks.some((chunk) => chunk.type === 'activity')).toBe(true);
    expect(chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({ costUsd: expect.any(Number) });
  });

  it('runs read-only in a throwaway folder when there is no project folder', async () => {
    const echo = join(dir, 'echo.json');
    await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'echo-stdin', FAKE_CLI_ECHO_FILE: echo }, 'full_auto').generate(
        { modelId: 'haiku', prompt: 'hello', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    ).catch(() => undefined);
    const seen = JSON.parse(readFileSync(echo, 'utf8')) as { argv: string[]; cwd: string; text: string };
    expect(seen.text).toBe('hello');
    expect(seen.argv).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
    expect(seen.argv).not.toContain('bypassPermissions');
    expect(seen.cwd).toContain('ace-cli-');
    expect(existsSync(seen.cwd)).toBe(false);
  });

  it('refuses a project folder that does not exist', async () => {
    const error = await drain(
      fakeAdapter({ FAKE_CLI_MODE: 'echo-stdin' }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: join(dir, 'gone') },
        new AbortController().signal,
      ),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ nodeError: { kind: 'invalid_config', code: 'project_folder_missing' } });
  });

  it('a Stop ends the call as user_cancelled and kills the CLI', async () => {
    const controller = new AbortController();
    const pending = drain(
      fakeAdapter({ FAKE_CLI_MODE: 'hang-with-child', FAKE_CLI_PIDFILE: join(dir, 'pid') }).generate(
        { modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir },
        controller.signal,
      ),
    ).catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 300);
    expect(await pending).toMatchObject({ nodeError: { kind: 'user_cancelled' } });
  });

  it('reports a missing CLI with its install hint', async () => {
    const adapter = createClaudeCodeAdapter({ permission: 'edit_files', detect: async () => signedIn, resolve: () => undefined });
    const error = await drain(
      adapter.generate({ modelId: 'haiku', prompt: 'x', outputTypes: ['text'], workingDir: dir }, new AbortController().signal),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ nodeError: { code: 'cli_not_found', retryable: false } });
    expect((error as { nodeError: { message: string } }).nodeError.message).toContain('npm install -g @anthropic-ai/claude-code');
  });
});

describe('X1 check() reads the terminal scan (D265)', () => {
  const adapterWith = (found: CliDetection) =>
    createClaudeCodeAdapter({ permission: 'edit_files', detect: async () => found });

  it('installed and signed in → CONNECTED, with version and sign-in method', async () => {
    expect(await adapterWith(signedIn).check()).toEqual({ status: 'CONNECTED', message: 'v2.1.282 · claude.ai · max' });
  });
  it('signed out → AUTH_FAILED, saying what to run', async () => {
    expect(await adapterWith({ ...signedIn, login: 'logged_out' }).check()).toMatchObject({
      status: 'AUTH_FAILED',
      message: expect.stringContaining('claude auth login'),
    });
  });
  it('not installed → UNREACHABLE, saying how to install', async () => {
    expect(await adapterWith({ ...signedIn, installed: false }).check()).toMatchObject({
      status: 'UNREACHABLE',
      message: expect.stringContaining('npm install -g @anthropic-ai/claude-code'),
    });
  });
});
