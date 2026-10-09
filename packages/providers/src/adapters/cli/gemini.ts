import type { CliPermission, NodeError } from '@ace/contracts';

import { ProviderCallError, type ModelInfo, type ProviderAdapter, type StreamChunk } from '../../adapter.js';
import {
  cliExitError,
  cliModel,
  createCliAdapter,
  summariseToolOutput,
  tokenCount,
  withSystem,
  type CliAdapterOptions,
  type CliDialect,
  type CliParser,
} from './adapter.js';

/**
 * Gemini CLI headless (X1 spec §5.1, from its docs and source; not installed on the dev machine, so
 * verified against a fake CLI only). It runs headless when stdin is not a terminal; `--skip-trust`
 * stops an untrusted folder forcing the approval mode back to default, and GEMINI_CLI_NO_RELAUNCH
 * keeps it one process, so a Stop's tree kill reaches it. Tokens, no cost (D263).
 */
export const GEMINI_BASE_ARGS = ['-o', 'stream-json', '--skip-trust'] as const;

const APPROVAL_MODE: Readonly<Record<CliPermission, string>> = {
  read_only: 'plan',
  edit_files: 'auto_edit',
  full_auto: 'yolo',
};

export const GEMINI_MODELS: readonly ModelInfo[] = [
  cliModel('default', 'Gemini CLI default'),
  cliModel('pro', 'Gemini Pro'),
  cliModel('flash', 'Gemini Flash'),
  cliModel('flash-lite', 'Gemini Flash-Lite'),
];

export function geminiError(message: string, exitCode?: number | null): NodeError {
  if (exitCode === 41 || /not signed in|login|credential|api key|authenticat/i.test(message)) {
    return { kind: 'auth', code: 'cli_not_signed_in', message: `Gemini CLI is not signed in — run \`gemini\` in a terminal and sign in. ${message}`.trim(), retryable: false };
  }
  if (exitCode === 55 || /untrusted|trust/i.test(message)) {
    return { kind: 'invalid_config', code: 'cli_untrusted_folder', message: `Gemini CLI does not trust this folder. ${message}`.trim(), retryable: false };
  }
  if (exitCode === 53) {
    return { kind: 'agent', code: 'cli_max_turns', message: `Gemini CLI stopped at its turn limit. ${message}`.trim(), retryable: false };
  }
  if (/quota|\b429\b|rate limit|resource exhausted/i.test(message)) {
    return { kind: 'provider', code: 'http_429', message: `Gemini CLI limit reached: ${message}`, retryable: true };
  }
  return { kind: 'provider', code: 'cli_failed', message: `Gemini CLI failed: ${message}`, retryable: false };
}

export function createGeminiParser(now: () => number = Date.now): CliParser {
  const pending = new Map<string, { tool: string; args: unknown; startedAt: number }>();
  let streamed = false;
  let wroteText = false;
  let newTurn = false;
  let lastError: string | undefined;
  let result: Record<string, unknown> | undefined;

  const text = (content: string): StreamChunk => {
    const prefix = newTurn && wroteText ? '\n\n' : '';
    newTurn = false;
    wroteText = true;
    return { type: 'text', delta: `${prefix}${content}` };
  };

  return {
    onEvent(event) {
      switch (event['type']) {
        case 'message': {
          if (event['role'] !== 'assistant' || typeof event['content'] !== 'string') return [];
          if (event['delta'] === true) {
            streamed = true;
            return [text(event['content'])];
          }
          // A whole message after its deltas repeats them.
          return streamed ? [] : [text(event['content'])];
        }
        case 'tool_use':
          if (typeof event['tool_id'] === 'string') {
            pending.set(event['tool_id'], {
              tool: typeof event['tool_name'] === 'string' ? event['tool_name'] : 'tool',
              args: event['parameters'] ?? {},
              startedAt: now(),
            });
          }
          newTurn = true;
          return [];
        case 'tool_result': {
          if (typeof event['tool_id'] !== 'string') return [];
          const started = pending.get(event['tool_id']);
          if (started === undefined) return [];
          pending.delete(event['tool_id']);
          const error = event['error'] as { message?: unknown } | undefined;
          return [
            {
              type: 'activity',
              tool: started.tool,
              args: started.args,
              status: event['status'] === 'success' ? 'ok' : 'error',
              summary: summariseToolOutput(event['output'] ?? error?.message ?? ''),
              durationMs: Math.max(0, now() - started.startedAt),
            },
          ];
        }
        case 'error':
          if (event['severity'] === 'error' && typeof event['message'] === 'string') lastError = event['message'];
          return [];
        case 'result':
          result = event;
          return [];
        default:
          return [];
      }
    },

    finish(exit) {
      if (result !== undefined && result['status'] !== 'error') {
        const stats = (result['stats'] ?? {}) as Record<string, unknown>;
        return [
          { type: 'usage', tokensIn: tokenCount(stats['input_tokens']), tokensOut: tokenCount(stats['output_tokens']) },
          { type: 'finish', reason: 'stop' },
        ];
      }
      const said = (result?.['error'] as { message?: unknown } | undefined)?.message;
      const message = typeof said === 'string' ? said : (lastError ?? '');
      if (message !== '' || (exit.code !== null && [41, 53, 55].includes(exit.code))) {
        throw new ProviderCallError(geminiError(message, exit.code));
      }
      throw new ProviderCallError(cliExitError('Gemini CLI', exit));
    },
  };
}

export const geminiDialect: CliDialect = {
  type: 'gemini_cli',
  bin: 'gemini',
  label: 'Gemini CLI',
  args: (req, permission) => [
    ...GEMINI_BASE_ARGS,
    '--approval-mode',
    APPROVAL_MODE[permission],
    ...(req.modelId === 'default' ? [] : ['-m', req.modelId]),
  ],
  stdin: withSystem,
  env: (base) => ({ ...base, GEMINI_CLI_NO_RELAUNCH: 'true' }),
  createParser: () => createGeminiParser(),
  listModels: async () => [...GEMINI_MODELS],
};

export function createGeminiAdapter(options: CliAdapterOptions): ProviderAdapter {
  return createCliAdapter(geminiDialect, options);
}
