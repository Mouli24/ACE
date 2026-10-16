import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { LocalModelControl, LocalRuntimeProbe } from '@ace/engine';

import type { FetchLike } from './ai-sdk.js';
import { resolveCommand } from './cli/resolve.js';
import {
  DEFAULT_OLLAMA_BASE_URL,
  ollamaLoadModel,
  ollamaPullModel,
  ollamaRunningModels,
  ollamaUnloadModel,
  ollamaVersion,
} from './ollama.js';

/**
 * The local Ollama runtime, without a terminal (PG-1.4, D359): find the binary when the server is
 * not running, start `ollama serve` hidden, and stop only the server this engine started.
 */

/** How long a started server has to answer `/api/version`. */
export const OLLAMA_START_TIMEOUT_MS = 15_000;
const START_POLL_MS = 300;

export interface OllamaRuntimeOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Finds the binary; the default looks on PATH, then where the installers put it. */
  findBinary?: () => string | undefined;
  /** Starts `ollama serve`; injectable so a test never starts a real one. */
  spawnServe?: (binary: string) => ChildProcess;
  startTimeoutMs?: number;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Where the Ollama installers put the binary, per platform — tried after PATH. */
export function ollamaInstallCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
    return [
      ...(local === undefined ? [] : [join(local, 'Programs', 'Ollama', 'ollama.exe')]),
      join(programFiles, 'Ollama', 'ollama.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Ollama.app/Contents/Resources/ollama',
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
    ];
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama', '/snap/bin/ollama'];
}

/** The Ollama binary on this machine: PATH first, then the installers' locations. */
export function findOllamaBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const onPath = resolveCommand('ollama', { env, platform });
  if (onPath !== undefined && onPath.prefixArgs.length === 0) return onPath.command;
  return ollamaInstallCandidates(platform, env).find(isFile);
}

/** Only a server on this machine can be started by this engine. */
function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOllamaRuntime(options: OllamaRuntimeOptions = {}): LocalModelControl {
  const baseUrl = options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
  const fetchImpl = options.fetchImpl;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const findBinary = options.findBinary ?? (() => findOllamaBinary(env, platform));
  const startTimeoutMs = options.startTimeoutMs ?? OLLAMA_START_TIMEOUT_MS;
  const spawnServe =
    options.spawnServe ??
    ((binary: string) =>
      spawn(binary, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...env, OLLAMA_HOST: new URL(baseUrl).host },
      }));

  /** The server this engine started, while it lives. */
  let owned: ChildProcess | undefined;
  let lastError: string | undefined;
  let starting: Promise<LocalRuntimeProbe> | undefined;

  async function probe(): Promise<LocalRuntimeProbe> {
    const version = await ollamaVersion(baseUrl, fetchImpl);
    const binaryPath = findBinary();
    const running = version !== undefined;
    return {
      installed: binaryPath !== undefined || running,
      running,
      startedByAce: running && owned !== undefined && owned.exitCode === null,
      baseUrl,
      ...(binaryPath === undefined ? {} : { binaryPath }),
      ...(version === undefined || version === '' ? {} : { version }),
      ...(running || lastError === undefined ? {} : { error: lastError }),
    };
  }

  async function start(): Promise<LocalRuntimeProbe> {
    const before = await probe();
    if (before.running || !isLoopback(baseUrl)) return before;
    const binary = before.binaryPath;
    if (binary === undefined) return before;

    let child: ChildProcess;
    try {
      child = spawnServe(binary);
    } catch (error) {
      lastError = `Ollama could not be started: ${errorText(error)}`;
      return { ...before, error: lastError };
    }
    let exited = false;
    child.once('exit', () => {
      exited = true;
      if (owned === child) owned = undefined;
    });
    child.once('error', (error) => {
      exited = true;
      lastError = `Ollama could not be started: ${errorText(error)}`;
      if (owned === child) owned = undefined;
    });
    child.unref();
    owned = child;

    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
      const version = await ollamaVersion(baseUrl, fetchImpl);
      if (version !== undefined) {
        lastError = undefined;
        return probe();
      }
      if (exited) break;
    }
    lastError ??= `Ollama was started but did not answer within ${Math.round(startTimeoutMs / 1000)} s.`;
    if (exited && lastError.startsWith('Ollama was started')) {
      lastError = 'Ollama was started but stopped straight away.';
    }
    return { ...(await probe()), error: lastError };
  }

  return {
    status: probe,

    ensureRunning() {
      starting ??= start().finally(() => {
        starting = undefined;
      });
      return starting;
    },

    async stopOwned() {
      const child = owned;
      owned = undefined;
      if (child === undefined || child.exitCode !== null || child.pid === undefined) return;
      const pid = child.pid;
      try {
        if (platform === 'win32') {
          // Its model runners are children of the server: the whole tree goes.
          const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          await new Promise<void>((resolve) => {
            killer.once('exit', () => resolve());
            killer.once('error', () => resolve());
          });
        } else {
          // Detached, so it leads its own process group: the negative pid reaches its runners.
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            process.kill(pid, 'SIGTERM');
          }
        }
      } catch {
        // already gone
      }
    },

    running: (url) => ollamaRunningModels(url, fetchImpl),
    load: (url, modelId) => ollamaLoadModel(url, modelId, fetchImpl),
    unload: (url, modelId) => ollamaUnloadModel(url, modelId, fetchImpl),
    pull: (url, name, onProgress, signal) =>
      ollamaPullModel(url, name, onProgress, {
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
