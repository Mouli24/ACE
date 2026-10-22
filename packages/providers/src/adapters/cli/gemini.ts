import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLI_INSTALL_HINTS, type CliPermission, type NodeError } from '@ace/contracts';

import { ProviderCallError, type ModelInfo, type ProviderAdapter, type StreamChunk } from '../../adapter.js';
import {
  cliExitError,
  cliModel,
  createCliAdapter,
  summariseToolOutput,
  withSystem,
  type CliAdapterOptions,
  type CliDialect,
  type CliParser,
} from './adapter.js';

/**
 * Gemini CLI headless (X1 spec §5.1, from its docs and source; not installed on the dev machine, so
 * verified against a fake CLI only). It runs headless when stdin is not a terminal; `--skip-trust`
 * stops an untrusted folder forcing the approval mode back to default, and GEMINI_CLI_NO_RELAUNCH
 * keeps it one process, so a Stop's tree kill reaches it.
 *
 * D313: Gemini is estimated-only. Its usage fields have never been seen in real output — it is not
 * installed where ACE is built — so none is read, no usage chunk is yielded, and the executor
 * estimates the turn. Capture its output with `scripts/live/capture-usage.ts` before reading any.
 */
export const GEMINI_BASE_ARGS = ['-o', 'stream-json', '--skip-trust'] as const;

/** D355 (PG-2.3): no preset approves everything; an old `full_auto` row runs as `edit_files`. */
const APPROVAL_MODE: Readonly<Record<CliPermission, string>> = {
  read_only: 'plan',
  edit_files: 'auto_edit',
  full_auto: 'auto_edit',
};

/**
 * Gemini CLI's models (D286). It has no command that lists them, so ACE offers only what the CLI
 * itself is set up to use — never a list of its own: `default` (no `-m`, whatever the CLI's
 * configuration picks), the model its `~/.gemini/settings.json` names, and `GEMINI_MODEL` from the
 * environment. Another model can be chosen by setting it there.
 */
export function geminiModelsFrom(source: {
  settings: unknown;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): ModelInfo[] {
  const settings = (typeof source.settings === 'object' && source.settings !== null
    ? source.settings
    : {}) as { model?: unknown };
  const configured =
    typeof settings.model === 'string'
      ? settings.model
      : typeof settings.model === 'object' && settings.model !== null
        ? (settings.model as { name?: unknown }).name
        : undefined;

  const models: ModelInfo[] = [
    {
      ...cliModel('default', 'Gemini CLI default'),
      description: 'Whatever model Gemini CLI is configured to use',
    },
  ];
  const named: [unknown, string][] = [
    [configured, 'Set as the model in ~/.gemini/settings.json'],
    [source.env['GEMINI_MODEL'], 'Set by GEMINI_MODEL in the environment'],
  ];
  for (const [value, description] of named) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const modelId = value.trim();
    if (models.some((model) => model.modelId === modelId)) continue;
    models.push({ ...cliModel(modelId, modelId), description });
  }
  return models;
}

function readGeminiSettings(): unknown {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.gemini', 'settings.json'), 'utf8')) as unknown;
  } catch {
    // No settings file: the CLI has never been configured on this machine.
    return undefined;
  }
}

export function geminiError(message: string, exitCode?: number | null): NodeError {
  if (exitCode === 41 || /not signed in|login|credential|api key|authenticat/i.test(message)) {
    return { kind: 'auth', code: 'cli_not_signed_in', message: `Gemini CLI is not signed in — run \`gemini\` in a terminal and sign in. ${message}`.trim(), retryable: false };
  }
  if (exitCode === 55 || /untrusted|trust/i.test(message)) {
    return { kind: 'invalid_config', code: 'cli_untrusted_folder', message: `Gemini CLI does not trust this folder. ${message}`.trim(), retryable: false };
  }
  if (exitCode === 53) {
    return { kind: 'provider', code: 'cli_max_turns', message: `Gemini CLI stopped at its turn limit. ${message}`.trim(), retryable: false };
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
        case 'init':
          // The session's opening event names the model it is using (D286).
          return typeof event['model'] === 'string' && event['model'] !== ''
            ? [{ type: 'model', modelId: event['model'] }]
            : [];
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
        return [{ type: 'finish', reason: 'stop' }];
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
  args: (req, permission, access) => [
    ...GEMINI_BASE_ARGS,
    '--approval-mode',
    // D383: `plan` is read-only, `auto_edit` approves edits and leaves shell tools asking, which
    // headless refuses. Gemini has no command allowlist outside policy files, so `edit_commands`
    // gets no more than `edit_files` and the selector disables it.
    APPROVAL_MODE[access === undefined ? permission : access.access === 'read_only' ? 'read_only' : 'edit_files'],
    ...(req.modelId === 'default' ? [] : ['-m', req.modelId]),
    // D389: `req.reasoningEffort` is not applied — Gemini CLI has no effort flag.
  ],
  stdin: withSystem,
  env: (base) => ({ ...base, GEMINI_CLI_NO_RELAUNCH: 'true' }),
  createParser: () => createGeminiParser(),
  listModels: async (resolve) => {
    if (resolve() === undefined) {
      throw new ProviderCallError({
        kind: 'provider',
        code: 'cli_not_found',
        message: `Gemini CLI is not installed — ${CLI_INSTALL_HINTS.gemini_cli}`,
        retryable: false,
      });
    }
    return geminiModelsFrom({ settings: readGeminiSettings(), env: process.env });
  },
};

export function createGeminiAdapter(options: CliAdapterOptions): ProviderAdapter {
  return createCliAdapter(geminiDialect, options);
}
