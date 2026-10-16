import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLI_INSTALL_HINTS, type NodeError } from '@ace/contracts';

import { ProviderCallError, type ModelInfo } from '../../adapter.js';
import { cliModel } from './adapter.js';
import { parseJsonLine } from './lines.js';
import type { ResolvedCommand } from './resolve.js';
import { cliEnv } from './env.js';

/**
 * Claude Code's models, as the installed CLI lists them (D286).
 *
 * Claude Code's stream-json input mode speaks a control protocol, and its `initialize` answer
 * carries `models` — every model its own `/model` picker offers this account on this version, each
 * with the alias or full name to pass to `--model`, the exact model it resolves to, a display name
 * and a description — and `unavailable_models`, the ones this version is too old for. That is the
 * CLI's own word for what it can run, so it is the only source: nothing here is a fixed list.
 *
 * Asking costs nothing. No user message is sent, so no model is called; once the answer arrives
 * stdin is closed and the CLI exits by itself. It is started exactly as a run starts it —
 * `--setting-sources ""` and a throwaway folder — so `default` resolves to the model a run with
 * `default` would actually get, not to whatever the user's own settings pick.
 */

/** The flags of the handshake: the run's own isolation flags, stream-json both ways, no prompt. */
export const CLAUDE_MODEL_LIST_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--setting-sources',
  '',
  '--strict-mcp-config',
] as const;

const DEFAULT_TIMEOUT_MS = 20_000;

type Entry = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/**
 * The models in an `initialize` answer: `models` first, in the CLI's order, then
 * `unavailable_models` marked unavailable with the CLI's own reason. An entry without a `value` is
 * skipped and a repeat is dropped; an answer with no list yields none — never a guess.
 */
export function claudeModelsFrom(response: unknown): ModelInfo[] {
  const body = (typeof response === 'object' && response !== null ? response : {}) as Entry;
  const seen = new Set<string>();
  const models: ModelInfo[] = [];

  const add = (raw: unknown, usable: boolean): void => {
    if (typeof raw !== 'object' || raw === null) return;
    const entry = raw as Entry;
    const value = text(entry['value']);
    if (value === undefined || seen.has(value)) return;
    seen.add(value);

    const description = text(entry['description']);
    const resolved = text(entry['resolvedModel']);
    const available = usable && entry['disabled'] !== true;
    models.push({
      ...cliModel(value, text(entry['displayName']) ?? value),
      available,
      ...(description === undefined ? {} : { description }),
      ...(resolved === undefined || resolved === value ? {} : { resolvedModelId: resolved }),
      ...(available
        ? {}
        : {
            unavailableReason: description ?? 'This version of Claude Code cannot use this model.',
          }),
    });
  };

  for (const entry of Array.isArray(body['models']) ? body['models'] : []) add(entry, true);
  for (const entry of Array.isArray(body['unavailable_models']) ? body['unavailable_models'] : []) {
    add(entry, false);
  }
  return models;
}

const failure = (nodeError: NodeError): ProviderCallError => new ProviderCallError(nodeError);

/** What a refused handshake means: signed out is an auth failure, anything else the provider's. */
function refusal(said: string): ProviderCallError {
  if (/not logged in|\/login|log in|authenticat|invalid api key/i.test(said)) {
    return failure({
      kind: 'auth',
      code: 'cli_not_signed_in',
      message: `Claude Code is not signed in — run \`claude auth login\`. ${said}`.trim(),
      retryable: false,
    });
  }
  return failure({
    kind: 'provider',
    code: 'cli_model_list_failed',
    message: `Claude Code would not list its models: ${said}`,
    retryable: false,
  });
}

export interface ListClaudeModelsOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Ask the installed CLI for its models (see the module comment). Rejects with a `ProviderCallError`. */
export function listClaudeCodeModels(
  command: ResolvedCommand,
  options: ListClaudeModelsOptions = {},
): Promise<ModelInfo[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const scratch = mkdtempSync(join(tmpdir(), 'ace-claude-models-'));

  return new Promise<ModelInfo[]>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;

    const finish = (outcome: { models: ModelInfo[] } | { error: ProviderCallError }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Closing stdin is what ends a CLI that answered; a kill is for one that did not.
      child.stdin?.end();
      if ('error' in outcome) child.kill();
      if ('error' in outcome) reject(outcome.error);
      else resolve(outcome.models);
    };

    const timer = setTimeout(() => {
      finish({
        error: failure({
          kind: 'provider',
          code: 'cli_model_list_timeout',
          message: `Claude Code did not list its models within ${Math.round(timeoutMs / 1000)} s.`,
          retryable: true,
        }),
      });
    }, timeoutMs);

    try {
      child = spawn(command.command, [...command.prefixArgs, ...CLAUDE_MODEL_LIST_ARGS], {
        cwd: scratch,
        // D-093: Claude Code's own variables and the system's, never the engine's whole env
        env: options.env ?? cliEnv(process.env, process.platform, 'claude_code'),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      reject(
        failure({
          kind: 'provider',
          code: 'cli_spawn_failed',
          message: `Claude Code could not be started: ${(error as Error).message}`,
          retryable: false,
        }),
      );
      return;
    }

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        error: failure({
          kind: 'provider',
          code: error.code === 'ENOENT' ? 'cli_not_found' : 'cli_spawn_failed',
          message:
            error.code === 'ENOENT'
              ? `Claude Code is not installed — ${CLI_INSTALL_HINTS.claude_code}`
              : `Claude Code could not be started: ${error.message}`,
          retryable: false,
        }),
      });
    });

    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });

    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        const event = parseJsonLine(line);
        if (event?.['type'] !== 'control_response') continue;

        const response = (event['response'] ?? {}) as Entry;
        if (response['subtype'] === 'success') {
          finish({ models: claudeModelsFrom(response['response']) });
        } else {
          finish({
            error: refusal(text(response['error']) ?? 'the handshake was refused'),
          });
        }
        return;
      }
    });

    child.on('close', (code) => {
      // Only now: Windows will not delete the folder a live process is working in.
      try {
        rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // The OS reclaims temp itself.
      }
      // Exited without answering: a version that predates the control protocol, or one that
      // failed to start. Never fall back to a remembered list — say what to do instead.
      const tail = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
      finish({
        error: failure({
          kind: 'provider',
          code: 'cli_model_list_unsupported',
          message:
            `This version of Claude Code did not report its models (exit ${code ?? 'signal'}` +
            `${tail === '' ? '' : `: ${tail}`}). Update it with \`claude update\` and refresh again.`,
          retryable: false,
        }),
      });
    });

    child.stdin?.on('error', () => {
      // The CLI closed its stdin first; `close` reports what happened.
    });
    child.stdin?.write(
      `${JSON.stringify({ type: 'control_request', request_id: 'ace_models_1', request: { subtype: 'initialize' } })}\n`,
    );
  });
}
