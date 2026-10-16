import { CLI_INSTALL_HINTS, type CliPermission, type NodeError } from '@ace/contracts';

import { ProviderCallError, type ProviderAdapter } from '../../adapter.js';
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
import { probeCommand } from './detect.js';

/**
 * Codex CLI's `exec` mode (X1 spec §5.1, from Codex's docs and source; not installed on the dev
 * machine, so verified against a fake CLI only). `exec` never asks for approval; the sandbox flag
 * is the preset. Codex reports whole messages, not deltas.
 *
 * D313: Codex is estimated-only. Its usage fields have never been seen in real output — it is not
 * installed where ACE is built — so none is read, no usage chunk is yielded, and the executor
 * estimates the turn. Capture its output with `scripts/live/capture-usage.ts` before reading any.
 */
export const CODEX_BASE_ARGS = ['exec', '--json', '--skip-git-repo-check', '--color', 'never'] as const;

/** D355 (PG-2.3): no preset bypasses the sandbox; an old `full_auto` row runs as `edit_files`. */
const PERMISSION_ARGS: Readonly<Record<CliPermission, readonly string[]>> = {
  read_only: ['--sandbox', 'read-only'],
  edit_files: ['--sandbox', 'workspace-write'],
  full_auto: ['--sandbox', 'workspace-write'],
};

const messageOf = (value: unknown): string => {
  if (typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return typeof value === 'string' ? value : JSON.stringify(value ?? 'unknown error');
};

export function codexError(message: string): NodeError {
  if (/not logged in|unauthori[sz]ed|\b401\b|please log ?in/i.test(message)) {
    return { kind: 'auth', code: 'cli_not_signed_in', message: `Codex CLI is not signed in — run \`codex login\`. ${message}`, retryable: false };
  }
  if (/rate limit|\b429\b|usage limit|quota/i.test(message)) {
    return { kind: 'provider', code: 'http_429', message: `Codex CLI limit reached: ${message}`, retryable: true };
  }
  return { kind: 'provider', code: 'cli_turn_failed', message: `Codex CLI failed: ${message}`, retryable: false };
}

export function createCodexParser(now: () => number = Date.now): CliParser {
  const started = new Map<string, number>();
  let wroteText = false;
  let completed = false;
  let turnFailure: string | undefined;
  let lastError: string | undefined;

  const took = (id: unknown): number => {
    if (typeof id !== 'string') return 0;
    const at = started.get(id);
    return at === undefined ? 0 : Math.max(0, now() - at);
  };

  return {
    onEvent(event) {
      const item = (event['item'] ?? {}) as Record<string, unknown>;
      switch (event['type']) {
        case 'item.started':
          if (typeof item['id'] === 'string') started.set(item['id'], now());
          return [];
        case 'item.completed': {
          switch (item['type']) {
            case 'agent_message': {
              if (typeof item['text'] !== 'string' || item['text'] === '') return [];
              const delta = `${wroteText ? '\n\n' : ''}${item['text']}`;
              wroteText = true;
              return [{ type: 'text', delta }];
            }
            case 'command_execution':
              return [
                {
                  type: 'activity',
                  tool: 'command',
                  args: { command: item['command'] },
                  status: item['exit_code'] === 0 && item['status'] !== 'failed' && item['status'] !== 'declined' ? 'ok' : 'error',
                  summary: summariseToolOutput(item['aggregated_output'] ?? ''),
                  durationMs: took(item['id']),
                },
              ];
            case 'file_change': {
              const changes = Array.isArray(item['changes']) ? (item['changes'] as { path?: unknown; kind?: unknown }[]) : [];
              return [
                {
                  type: 'activity',
                  tool: 'file_change',
                  args: { changes },
                  status: item['status'] === 'failed' ? 'error' : 'ok',
                  summary: changes.map((change) => `${String(change.kind ?? 'update')} ${String(change.path ?? '')}`).join(', ').slice(0, 500),
                  durationMs: took(item['id']),
                },
              ];
            }
            case 'mcp_tool_call':
              return [
                {
                  type: 'activity',
                  tool: `mcp_${String(item['server'] ?? 'server')}_${String(item['tool'] ?? 'tool')}`,
                  args: item['arguments'] ?? {},
                  status: item['error'] === undefined || item['error'] === null ? 'ok' : 'error',
                  summary: summariseToolOutput(item['error'] ?? item['result'] ?? ''),
                  durationMs: took(item['id']),
                },
              ];
            case 'web_search':
              return [
                {
                  type: 'activity',
                  tool: 'web_search',
                  args: { query: item['query'] },
                  status: 'ok',
                  summary: String(item['query'] ?? ''),
                  durationMs: took(item['id']),
                },
              ];
            default:
              return [];
          }
        }
        case 'turn.completed':
          completed = true;
          return [];
        case 'turn.failed':
          turnFailure = messageOf(event['error']);
          return [];
        case 'error':
          // Sometimes a recoverable notice; it only decides the outcome if the turn never completes.
          lastError = messageOf(event);
          return [];
        default:
          return [];
      }
    },

    finish(exit) {
      if (turnFailure !== undefined) throw new ProviderCallError(codexError(turnFailure));
      if (completed) return [{ type: 'finish', reason: 'stop' }];
      if (lastError !== undefined) throw new ProviderCallError(codexError(lastError));
      throw new ProviderCallError(cliExitError('Codex CLI', exit));
    },
  };
}

/** Model ids from `codex debug models` — an array, or `{ models: [...] }`, of ids or objects. */
export function codexModelsFrom(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { models?: unknown }).models)
        ? (parsed as { models: unknown[] }).models
        : [];
    return list
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry === 'object' && entry !== null) {
          const record = entry as Record<string, unknown>;
          const id = record['slug'] ?? record['id'] ?? record['model'];
          return typeof id === 'string' ? id : '';
        }
        return '';
      })
      .filter((id) => id !== '' && id !== 'default');
  } catch {
    return [];
  }
}

export const codexDialect: CliDialect = {
  type: 'codex_cli',
  bin: 'codex',
  label: 'Codex CLI',
  args: (req, permission) => [
    ...CODEX_BASE_ARGS,
    ...PERMISSION_ARGS[permission],
    ...(req.modelId === 'default' ? [] : ['-m', req.modelId]),
    '-',
  ],
  stdin: withSystem,
  createParser: () => createCodexParser(),
  listModels: async (resolve) => {
    const command = resolve();
    // No CLI, no models: offering its `default` would show a model as usable that cannot run (D286).
    if (command === undefined) {
      throw new ProviderCallError({
        kind: 'provider',
        code: 'cli_not_found',
        message: `Codex CLI is not installed — ${CLI_INSTALL_HINTS.codex_cli}`,
        retryable: false,
      });
    }
    const fallback = [cliModel('default', 'Codex default')];
    const listed = await probeCommand(command, ['debug', 'models', '--bundled'], 10_000);
    return [...fallback, ...codexModelsFrom(listed.stdout).map((id) => cliModel(id, id))];
  },
};

export function createCodexAdapter(options: CliAdapterOptions): ProviderAdapter {
  return createCliAdapter(codexDialect, options);
}
