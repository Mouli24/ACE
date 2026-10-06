import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CLI_INSTALL_HINTS,
  CLI_LOGIN_HINTS,
  CLI_PROVIDER_TYPES,
  type CliDetectResponse,
  type CliDetection,
  type CliProviderType,
} from '@ace/contracts';

import { resolveCommand, type ResolvedCommand } from './resolve.js';

/**
 * The terminal scan (X1, FR-PRV-008): is each CLI on PATH, which version, is it signed in?
 *
 * Sign-in comes only from what the CLI itself reports (`claude auth status`, `codex login status`)
 * or, for Gemini, which has no status command, from which sign-in *method* is configured. ACE never
 * opens a credential file (D264), and keeps no identity — an email or org name is dropped here.
 */

export const CLI_BINARIES: Readonly<Record<CliProviderType, string>> = {
  claude_code: 'claude',
  codex_cli: 'codex',
  gemini_cli: 'gemini',
};

/** Each probe gets this long; a CLI that hangs on `--version` is reported found, version unknown. */
const PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 60_000;

export interface ProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface DetectDeps {
  resolve?: (bin: string) => ResolvedCommand | undefined;
  probe?: (command: ResolvedCommand, args: string[], timeoutMs: number) => Promise<ProbeResult>;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** Runs a short command without a shell and collects what it printed. Never throws. */
export function probeCommand(
  command: ResolvedCommand,
  args: string[],
  timeoutMs: number,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = spawn(command.command, [...command.prefixArgs, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: timeoutMs,
      });
    } catch {
      resolve({ code: null, stdout, stderr });
      return;
    }
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => resolve({ code: null, stdout, stderr }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const versionIn = (text: string): string | undefined => /\d+\.\d+\.\d+[\w.-]*/.exec(text)?.[0];

type Login = { login: CliDetection['login']; loginDetail?: string };
type Probe = NonNullable<DetectDeps['probe']>;

async function claudeLogin(command: ResolvedCommand, probe: Probe): Promise<Login> {
  const status = await probe(command, ['auth', 'status', '--json'], PROBE_TIMEOUT_MS);
  let parsed: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } = {};
  try {
    parsed = JSON.parse(status.stdout) as typeof parsed;
  } catch {
    parsed = {};
  }
  // Only the method and the plan — never the email or org the status also prints (D264).
  const detail = [parsed.authMethod, parsed.subscriptionType]
    .filter((part): part is string => typeof part === 'string' && part !== '' && part !== 'none')
    .join(' · ');
  if (status.code === 0 && parsed.loggedIn !== false) {
    return { login: 'logged_in', ...(detail === '' ? {} : { loginDetail: detail }) };
  }
  return status.code === null ? { login: 'unknown' } : { login: 'logged_out' };
}

async function codexLogin(
  command: ResolvedCommand,
  probe: Probe,
  env: NodeJS.ProcessEnv,
): Promise<Login> {
  const status = await probe(command, ['login', 'status'], PROBE_TIMEOUT_MS);
  if (status.code === 0) {
    const said = `${status.stdout}\n${status.stderr}`.trim();
    const detail = /logged in using (.+)/i.exec(said)?.[1]?.trim().split(/\s+-\s+/)[0];
    return { login: 'logged_in', ...(detail === undefined ? {} : { loginDetail: detail }) };
  }
  if ((env['CODEX_API_KEY'] ?? '') !== '') {
    return { login: 'logged_in', loginDetail: 'CODEX_API_KEY' };
  }
  return status.code === null ? { login: 'unknown' } : { login: 'logged_out' };
}

function geminiLogin(env: NodeJS.ProcessEnv, homeDir: string): Login {
  for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const) {
    if ((env[key] ?? '') !== '') return { login: 'logged_in', loginDetail: key };
  }
  if ((env['GOOGLE_GENAI_USE_VERTEXAI'] ?? '') === 'true') {
    return { login: 'logged_in', loginDetail: 'Vertex AI' };
  }
  try {
    const settings = JSON.parse(readFileSync(join(homeDir, '.gemini', 'settings.json'), 'utf8')) as {
      security?: { auth?: { selectedType?: unknown } };
      selectedAuthType?: unknown;
    };
    const method = settings.security?.auth?.selectedType ?? settings.selectedAuthType;
    if (typeof method === 'string' && method !== '') {
      // A method is configured; whether its sign-in is still valid shows on the first run.
      return { login: 'unknown', loginDetail: `Google sign-in (${method})` };
    }
  } catch {
    // No settings: Gemini has never been signed in on this machine.
  }
  return { login: 'logged_out' };
}

export async function detectCli(
  type: CliProviderType,
  deps: DetectDeps = {},
): Promise<CliDetection> {
  const env = deps.env ?? process.env;
  const probe = deps.probe ?? probeCommand;
  const hints = { installHint: CLI_INSTALL_HINTS[type], loginHint: CLI_LOGIN_HINTS[type] };
  const resolve = deps.resolve ?? ((bin: string) => resolveCommand(bin, { env }));
  const command = resolve(CLI_BINARIES[type]);
  if (command === undefined) return { type, installed: false, login: 'unknown', ...hints };

  const versionProbe = await probe(command, ['--version'], PROBE_TIMEOUT_MS);
  const version = versionIn(`${versionProbe.stdout} ${versionProbe.stderr}`);
  const login: Login =
    type === 'claude_code'
      ? await claudeLogin(command, probe)
      : type === 'codex_cli'
        ? await codexLogin(command, probe, env)
        : geminiLogin(env, deps.homeDir ?? homedir());

  return {
    type,
    installed: true,
    ...(version === undefined ? {} : { version }),
    path: command.path,
    login: login.login,
    ...(login.loginDetail === undefined ? {} : { loginDetail: login.loginDetail }),
    ...hints,
  };
}

export interface CliDetector {
  detect(type: CliProviderType, options?: { force?: boolean }): Promise<CliDetection>;
  detectAll(options?: { force?: boolean }): Promise<CliDetectResponse>;
}

/**
 * A scan is a handful of process starts, so it is cached: the 60 s provider health check reads the
 * cache, and the Add-provider scan forces a fresh one.
 */
export function createCliDetector(
  deps: DetectDeps & { ttlMs?: number; now?: () => number } = {},
): CliDetector {
  const ttl = deps.ttlMs ?? DEFAULT_TTL_MS;
  const now = deps.now ?? Date.now;
  const cache = new Map<CliProviderType, { at: number; value: Promise<CliDetection> }>();

  const detect: CliDetector['detect'] = (type, options = {}) => {
    const hit = cache.get(type);
    if (hit !== undefined && options.force !== true && now() - hit.at < ttl) return hit.value;
    const value = detectCli(type, deps);
    cache.set(type, { at: now(), value });
    // A failed scan must not stay cached.
    value.catch(() => cache.delete(type));
    return value;
  };

  return {
    detect,
    detectAll: async (options = {}) => ({
      items: await Promise.all(CLI_PROVIDER_TYPES.map((type) => detect(type, options))),
    }),
  };
}
