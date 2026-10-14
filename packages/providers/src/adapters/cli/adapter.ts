import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_INSTALL_HINTS,
  type CliDetection,
  type CliPermission,
  type CliProviderType,
  type NodeError,
} from '@ace/contracts';

import {
  ProviderCallError,
  abortedCallError,
  mapProviderError,
  type GenerateRequest,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderStatus,
  type StreamChunk,
} from '../../adapter.js';
import { parseJsonLine } from './lines.js';
import { resolveCommand, type ResolvedCommand } from './resolve.js';
import { runCli, type CliExit } from './runner.js';

/**
 * One adapter for every coding-agent CLI (X1 spec §5, D261): spawn the real CLI in the project
 * folder with the provider's permission preset, feed the prompt on stdin, and translate its JSONL
 * into `StreamChunk`s. Each CLI supplies only a {@link CliDialect} — its flags and its parser.
 */

/** Turns one CLI's events into chunks. A fresh parser per call. */
export interface CliParser {
  onEvent(event: Record<string, unknown>): StreamChunk[];
  /** After stdout ends: the closing usage and finish chunks, or a thrown `ProviderCallError`. */
  finish(exit: CliExit): StreamChunk[];
}

export interface CliDialect {
  type: CliProviderType;
  /** The command on PATH. */
  bin: string;
  /** How messages name it. */
  label: string;
  args(req: GenerateRequest, permission: CliPermission): string[];
  stdin(req: GenerateRequest): string;
  env?(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  createParser(): CliParser;
  /** The models it offers; `resolve` finds the binary, for a CLI that can list its own. */
  listModels(resolve: () => ResolvedCommand | undefined): Promise<ModelInfo[]>;
}

export interface CliAdapterOptions {
  permission: CliPermission;
  /** The terminal scan for this CLI — what `check()` reports. */
  detect: () => Promise<CliDetection>;
  /** Finds the binary; `resolveCommand(dialect.bin)` by default. Tests point it at a fake. */
  resolve?: () => ResolvedCommand | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** A CLI model: text in, text out, the CLI's own tools rather than ACE's (spec §5.1). */
export function cliModel(modelId: string, displayName: string): ModelInfo {
  return {
    modelId,
    displayName,
    inputTypes: ['text'],
    outputTypes: ['text'],
    contextWindow: 200_000,
    supportsTools: false,
    supportsJson: false,
  };
}

/** ACE's system section first, then the prompt — for CLIs with no system-prompt flag. */
export function withSystem(req: GenerateRequest): string {
  return req.system === undefined || req.system === '' ? req.prompt : `${req.system}\n\n${req.prompt}`;
}

/** What a tool returned, as one line for the inspector (FR-TOOL-009 keeps 500 characters). */
export function summariseToolOutput(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '',
            )
            .join(' ')
        : JSON.stringify(content ?? '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** A token count from a CLI's JSON, or 0 when it is missing or not a number. */
export const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** A CLI that ended without its result event. */
export function cliExitError(label: string, exit: CliExit): NodeError {
  if (exit.spawnError !== undefined) {
    return {
      kind: 'provider',
      code: exit.spawnError.code === 'ENOENT' ? 'cli_not_found' : 'cli_spawn_failed',
      message: `${label} could not be started: ${exit.spawnError.message}`,
      retryable: false,
    };
  }
  const tail = exit.stderrTail.trim().split(/\r?\n/).slice(-5).join(' ').slice(-500);
  const how = exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `code ${exit.code}`;
  return {
    kind: 'provider',
    code: `cli_exit_${exit.code ?? 'signal'}`,
    message: `${label} exited with ${how}${tail === '' ? ' and no output' : `: ${tail}`}`,
    retryable: false,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function createCliAdapter(dialect: CliDialect, options: CliAdapterOptions): ProviderAdapter {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolve = options.resolve ?? (() => resolveCommand(dialect.bin, { env, platform }));

  return {
    type: dialect.type,

    async check(): Promise<ProviderStatus> {
      const found = await options.detect();
      if (!found.installed) {
        return { status: 'UNREACHABLE', message: `${dialect.label} is not installed — ${found.installHint}` };
      }
      if (found.login === 'logged_out') {
        return {
          status: 'AUTH_FAILED',
          message: `${dialect.label} is not signed in — run \`${found.loginHint}\` in a terminal.`,
        };
      }
      const parts = [
        found.version === undefined ? undefined : `v${found.version}`,
        found.loginDetail,
        found.login === 'unknown' ? 'sign-in confirmed on the first run' : undefined,
      ].filter((part): part is string => part !== undefined);
      return { status: 'CONNECTED', ...(parts.length === 0 ? {} : { message: parts.join(' · ') }) };
    },

    listModels: () => dialect.listModels(resolve),

    generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
      return (async function* (): AsyncGenerator<StreamChunk> {
        const command = resolve();
        if (command === undefined) {
          throw new ProviderCallError({
            kind: 'provider',
            code: 'cli_not_found',
            message: `${dialect.label} is not installed — ${CLI_INSTALL_HINTS[dialect.type]}`,
            retryable: false,
          });
        }
        if (req.workingDir !== undefined && !isDirectory(req.workingDir)) {
          throw new ProviderCallError({
            kind: 'invalid_config',
            code: 'project_folder_missing',
            message: `The project folder does not exist: ${req.workingDir}`,
            retryable: false,
          });
        }

        // No project folder (direct chat, a summary): a throwaway folder, read-only (spec §4.2).
        const scratch = req.workingDir === undefined ? mkdtempSync(join(tmpdir(), 'ace-cli-')) : undefined;
        const cwd = req.workingDir ?? (scratch as string);
        // D359: a debate turn brings its own scratch folder and asks for read-only in it.
        const permission: CliPermission =
          scratch === undefined && req.readOnly !== true ? options.permission : 'read_only';

        const run = runCli({
          command: command.command,
          args: [...command.prefixArgs, ...dialect.args(req, permission)],
          cwd,
          env: dialect.env?.(env) ?? env,
          stdin: dialect.stdin(req),
          signal,
          platform,
        });
        const parser = dialect.createParser();
        let acted = false;

        try {
          for await (const line of run.lines) {
            const event = parseJsonLine(line);
            if (event === undefined) continue;
            for (const chunk of parser.onEvent(event)) {
              if (chunk.type === 'activity') acted = true;
              yield chunk;
            }
          }
          const exit = await run.exit;
          if (signal.aborted) throw new ProviderCallError(abortedCallError(undefined, { signal }));
          yield* parser.finish(exit);
        } catch (error) {
          const nodeError = signal.aborted
            ? abortedCallError(error, { signal })
            : mapProviderError(error, { signal });
          // Once the CLI has acted it may have changed files: running it again is not a retry (§5.2).
          throw new ProviderCallError(acted ? { ...nodeError, retryable: false } : nodeError);
        } finally {
          if (scratch !== undefined) {
            try {
              rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
            } catch {
              // A killed CLI can hold the folder a moment longer; the OS reclaims temp itself.
            }
          }
        }
      })();
    },
  };
}
