import type { CliPermission, NodeError } from '@ace/contracts';

import { ProviderCallError, type ModelInfo, type ProviderAdapter, type StreamChunk } from '../../adapter.js';
import {
  cliExitError,
  cliModel,
  createCliAdapter,
  summariseToolOutput,
  tokenCount,
  type CliAdapterOptions,
  type CliDialect,
  type CliParser,
} from './adapter.js';

/**
 * Claude Code in print mode (X1 spec §5.1). The flags were verified against Claude Code 2.1.282 on
 * 2026-10-06: `--setting-sources ""` keeps the user's own hooks and plugins (a SessionStart hook
 * that injects instructions, say) out of an agent run, and `--permission-prompts none` denies
 * anything the preset does not allow instead of waiting for a person who is not there.
 */
export const CLAUDE_CODE_BASE_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--setting-sources',
  '',
  '--strict-mcp-config',
  '--permission-prompts',
  'none',
] as const;

/** D262's presets. `edit_files` drops the shell entirely: on Windows there is no shell sandbox. */
const PERMISSION_ARGS: Readonly<Record<CliPermission, readonly string[]>> = {
  read_only: ['--permission-mode', 'dontAsk', '--tools', 'Read,Grep,Glob'],
  edit_files: ['--permission-mode', 'acceptEdits', '--tools', 'Read,Edit,Write,Grep,Glob'],
  full_auto: ['--permission-mode', 'bypassPermissions'],
};

/** Claude Code takes model aliases; `default` leaves the choice to the CLI's own setting. */
export const CLAUDE_CODE_MODELS: readonly ModelInfo[] = [
  cliModel('default', 'Claude Code default'),
  cliModel('opus', 'Claude Opus'),
  cliModel('sonnet', 'Claude Sonnet'),
  cliModel('haiku', 'Claude Haiku'),
];

type Block = Record<string, unknown>;

const blocksOf = (event: Record<string, unknown>): Block[] => {
  const message = event['message'] as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as Block[]) : [];
};

/** A `result` event that says the call failed, as the error kind it deserves (Arch §28). */
export function claudeResultError(result: Record<string, unknown>): NodeError {
  const said = [
    typeof result['result'] === 'string' ? result['result'] : '',
    ...(Array.isArray(result['errors']) ? result['errors'].map(String) : []),
  ]
    .join(' ')
    .trim();
  const status = typeof result['api_error_status'] === 'number' ? result['api_error_status'] : undefined;
  const subtype = typeof result['subtype'] === 'string' ? result['subtype'] : 'error';

  if (status === 401 || status === 403 || /not logged in|\/login|invalid api key|authenticat/i.test(said)) {
    return {
      kind: 'auth',
      code: 'cli_not_signed_in',
      message: `Claude Code is not signed in — run \`claude auth login\`. ${said}`.trim(),
      retryable: false,
    };
  }
  if (status === 429 || /usage limit|rate limit|limit reached|out of credits/i.test(said)) {
    return {
      kind: 'provider',
      code: 'http_429',
      message: `Claude Code plan limit reached: ${said === '' ? 'try again later' : said}`,
      retryable: true,
    };
  }
  // A provider failure, not the agent's: kind 'agent' would trigger contract repair, re-running a
  // CLI over files it already changed (§5.2, review I4).
  if (subtype === 'error_max_turns') {
    return {
      kind: 'provider',
      code: 'cli_max_turns',
      message: `Claude Code stopped at its turn limit. ${said}`.trim(),
      retryable: false,
    };
  }
  return {
    kind: 'provider',
    code: `cli_${subtype}`,
    message: `Claude Code failed (${subtype})${said === '' ? '' : `: ${said}`}`,
    retryable: false,
  };
}

export function createClaudeCodeParser(now: () => number = Date.now): CliParser {
  const pending = new Map<string, { tool: string; args: unknown; startedAt: number }>();
  /** Partial deltas arrived, so an `assistant` text block only repeats them. */
  let streamed = false;
  let wroteText = false;
  let newMessage = false;
  let result: Record<string, unknown> | undefined;

  const text = (delta: string): StreamChunk => {
    const prefix = newMessage && wroteText ? '\n\n' : '';
    newMessage = false;
    wroteText = true;
    return { type: 'text', delta: `${prefix}${delta}` };
  };

  return {
    onEvent(event) {
      // A sub-agent's turns carry its parent's tool id; only the main agent's words are the answer.
      const parent = event['parent_tool_use_id'];
      if (parent !== undefined && parent !== null) return [];

      switch (event['type']) {
        case 'stream_event': {
          const inner = event['event'] as
            | { type?: unknown; delta?: { type?: unknown; text?: unknown } }
            | undefined;
          if (inner?.type === 'message_start') {
            newMessage = true;
            return [];
          }
          if (
            inner?.type === 'content_block_delta' &&
            inner.delta?.type === 'text_delta' &&
            typeof inner.delta.text === 'string'
          ) {
            streamed = true;
            return [text(inner.delta.text)];
          }
          return [];
        }
        case 'assistant': {
          const out: StreamChunk[] = [];
          for (const block of blocksOf(event)) {
            if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
              pending.set(block['id'], {
                tool: typeof block['name'] === 'string' ? block['name'] : 'tool',
                args: block['input'] ?? {},
                startedAt: now(),
              });
            } else if (block['type'] === 'text' && !streamed && typeof block['text'] === 'string') {
              newMessage = true;
              out.push(text(block['text']));
            }
          }
          return out;
        }
        case 'user': {
          const out: StreamChunk[] = [];
          for (const block of blocksOf(event)) {
            if (block['type'] !== 'tool_result' || typeof block['tool_use_id'] !== 'string') continue;
            const started = pending.get(block['tool_use_id']);
            if (started === undefined) continue;
            pending.delete(block['tool_use_id']);
            out.push({
              type: 'activity',
              tool: started.tool,
              args: started.args,
              status: block['is_error'] === true ? 'error' : 'ok',
              summary: summariseToolOutput(block['content']),
              durationMs: Math.max(0, now() - started.startedAt),
            });
          }
          return out;
        }
        case 'result':
          result = event;
          return [];
        default:
          return [];
      }
    },

    finish(exit) {
      if (result === undefined) throw new ProviderCallError(cliExitError('Claude Code', exit));
      if (result['is_error'] === true || result['subtype'] !== 'success') {
        throw new ProviderCallError(claudeResultError(result));
      }
      const usage = (result['usage'] ?? {}) as Record<string, unknown>;
      const cost = result['total_cost_usd'];
      return [
        {
          type: 'usage',
          tokensIn:
            tokenCount(usage['input_tokens']) +
            tokenCount(usage['cache_read_input_tokens']) +
            tokenCount(usage['cache_creation_input_tokens']),
          tokensOut: tokenCount(usage['output_tokens']),
          ...(typeof cost === 'number' ? { costUsd: cost } : {}),
        },
        { type: 'finish', reason: 'stop' },
      ];
    },
  };
}

export const claudeCodeDialect: CliDialect = {
  type: 'claude_code',
  bin: 'claude',
  label: 'Claude Code',
  args: (req, permission) => [
    ...CLAUDE_CODE_BASE_ARGS,
    ...PERMISSION_ARGS[permission],
    ...(req.modelId === 'default' ? [] : ['--model', req.modelId]),
    ...(req.system === undefined || req.system === '' ? [] : ['--append-system-prompt', req.system]),
  ],
  stdin: (req) => req.prompt,
  createParser: () => createClaudeCodeParser(),
  listModels: async () => [...CLAUDE_CODE_MODELS],
};

export function createClaudeCodeAdapter(options: CliAdapterOptions): ProviderAdapter {
  return createCliAdapter(claudeCodeDialect, options);
}
