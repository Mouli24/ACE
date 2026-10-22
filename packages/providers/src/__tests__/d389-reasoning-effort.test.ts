/**
 * D389 Per-node reasoning effort, applied per adapter (docs/research/pandacode-integration-plan.md
 * W1-5, mapping table). Unset, every adapter sends exactly what it sent before.
 *
 * - AI SDK adapter (anthropic, openai, google, openai_compatible, ollama): AI SDK 7's `reasoning`
 *   call option, with `max` sent as `xhigh`, its top level.
 * - Claude Code: `--effort <level>` — 2.1.304 accepts low, medium, high, xhigh and max.
 * - Codex CLI: `-c model_reasoning_effort="<level>"`, with `max` sent as `xhigh`.
 * - Gemini CLI and the mock: not applied.
 */
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { GenerateRequest, StreamChunk } from '../adapter.js';
import { aiSdkReasoning, createAiSdkAdapter } from '../adapters/ai-sdk.js';
import { CLAUDE_CODE_BASE_ARGS, claudeCodeDialect } from '../adapters/cli/claude-code.js';
import { CODEX_BASE_ARGS, codexDialect, codexEffortArgs } from '../adapters/cli/codex.js';
import { GEMINI_BASE_ARGS, geminiDialect } from '../adapters/cli/gemini.js';
import { createMockAdapter } from '../adapters/mock.js';

const req: GenerateRequest = {
  modelId: 'sonnet',
  prompt: 'p',
  outputTypes: ['text'],
  system: 'You are a node.',
};

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

/* -------------------------------------------------------------------------- */
/* AI SDK adapter                                                              */
/* -------------------------------------------------------------------------- */

const answers = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Thought about it.' },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage: {
            inputTokens: { total: 4, noCache: 4, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: 3, reasoning: undefined },
          },
        },
      ]),
    }),
  });

const adapterOver = (model: MockLanguageModelV4) =>
  createAiSdkAdapter({
    type: 'anthropic',
    model: () => model,
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
  });

describe('D389 the AI SDK adapter passes the effort as AI SDK 7’s reasoning option', () => {
  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'xhigh'],
  ] as const)('%s is sent as reasoning %s', async (effort, sent) => {
    const model = answers();

    await drain(
      adapterOver(model).generate(
        { ...req, reasoningEffort: effort },
        new AbortController().signal,
      ),
    );

    expect(model.doStreamCalls[0]?.reasoning).toBe(sent);
    expect(aiSdkReasoning(effort)).toBe(sent);
  });

  it('unset, no reasoning option is sent: the call is what it was before', async () => {
    const model = answers();

    const chunks = await drain(adapterOver(model).generate(req, new AbortController().signal));

    expect(model.doStreamCalls[0]?.reasoning).toBeUndefined();
    expect(chunks.some((chunk) => chunk.type === 'text')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Coding-agent CLIs                                                           */
/* -------------------------------------------------------------------------- */

describe('D389 Claude Code takes --effort with the level as it is', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('%s → --effort %s', (effort) => {
    expect(claudeCodeDialect.args({ ...req, reasoningEffort: effort }, 'read_only')).toEqual([
      ...CLAUDE_CODE_BASE_ARGS,
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Grep,Glob',
      '--model',
      'sonnet',
      '--effort',
      effort,
      '--append-system-prompt',
      'You are a node.',
    ]);
  });

  it('unset, no --effort is sent', () => {
    expect(claudeCodeDialect.args(req, 'edit_files')).not.toContain('--effort');
  });

  it('rides along with the node’s own access level (D383)', () => {
    const args = claudeCodeDialect.args({ ...req, reasoningEffort: 'high' }, 'edit_files', {
      access: 'read_only',
      allowedCommands: [],
    });
    expect(args).toContain('dontAsk');
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual([
      '--effort',
      'high',
    ]);
  });
});

describe('D389 Codex takes -c model_reasoning_effort, with max sent as xhigh', () => {
  const codexReq: GenerateRequest = { ...req, modelId: 'gpt-6.1-sol', system: 'S' };

  it.each([
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'xhigh'],
  ] as const)('%s → model_reasoning_effort="%s"', (effort, sent) => {
    expect(codexDialect.args({ ...codexReq, reasoningEffort: effort }, 'read_only')).toEqual([
      ...CODEX_BASE_ARGS,
      '--sandbox',
      'read-only',
      '-m',
      'gpt-6.1-sol',
      '-c',
      `model_reasoning_effort="${sent}"`,
      '-',
    ]);
  });

  it('unset, no -c is sent and the prompt stays last on stdin', () => {
    const args = codexDialect.args(codexReq, 'edit_files');
    expect(args).not.toContain('-c');
    expect(args.at(-1)).toBe('-');
    expect(codexEffortArgs(undefined)).toEqual([]);
  });
});

describe('D389 Gemini CLI and the mock do not apply it', () => {
  it('Gemini CLI has no effort flag: the args are the same with or without one', () => {
    const geminiReq: GenerateRequest = { ...req, modelId: 'pro' };
    expect(geminiDialect.args({ ...geminiReq, reasoningEffort: 'max' }, 'read_only')).toEqual(
      geminiDialect.args(geminiReq, 'read_only'),
    );
    expect(geminiDialect.args(geminiReq, 'read_only').slice(0, GEMINI_BASE_ARGS.length)).toEqual([
      ...GEMINI_BASE_ARGS,
    ]);
  });

  it('the mock answers an effort exactly as it answers without one', async () => {
    const mock = createMockAdapter({ sleep: async () => {} });
    const plain: GenerateRequest = {
      modelId: 'mock-text',
      prompt: 'the same brief',
      outputTypes: ['text'],
    };
    const without = await drain(mock.generate(plain, new AbortController().signal));
    const withEffort = await drain(
      mock.generate({ ...plain, reasoningEffort: 'high' }, new AbortController().signal),
    );
    expect(withEffort).toEqual(without);
  });
});
