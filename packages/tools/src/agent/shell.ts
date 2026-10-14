import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * Agentic nodes, Phase 1 (FR-TOOL-008, `agentic-nodes-prompt.md` Command runner): which shell an
 * agent's `run_command` runs in.
 *
 * - Windows: Git Bash — `<Git>\bin\bash.exe`, found from the `git` on PATH — so a model can write
 *   the same `ls`, `grep`, `&&` it would anywhere else. Never `C:\Windows\System32\bash.exe`: that
 *   is the WSL launcher, a different machine with a different filesystem. Fallback: Windows
 *   PowerShell, `-NoProfile -NonInteractive`.
 * - macOS/Linux: `/bin/bash`, fallback `/bin/sh`.
 * - `ACE_AGENT_SHELL` (a path) overrides detection.
 *
 * Always non-login `-c`. The chosen shell's {@link AgentShell.label} goes into the node's system
 * prompt so the model writes matching syntax.
 */

export type AgentShellKind = 'bash' | 'powershell' | 'sh';

export interface AgentShell {
  readonly kind: AgentShellKind;
  /** The executable spawned. */
  readonly path: string;
  /** For the system prompt, e.g. `Git Bash (C:\Program Files\Git\bin\bash.exe) on Windows`. */
  readonly label: string;
  /** The arguments that run `command`. Use with {@link envFor} — or just {@link shellInvocation}. */
  argsFor(command: string): string[];
  /** Variables the invocation needs on top of the command's env (Windows bash carries the command there). */
  envFor(command: string): Record<string, string>;
}

export interface ResolveAgentShellOptions {
  readonly platform: NodeJS.Platform;
  /** Where PATH and `ACE_AGENT_SHELL` are read from (the engine's env; never passed to the child). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Finds an executable on PATH. Defaults to a PATH/PATHEXT search through {@link exists}. */
  readonly which?: (name: string) => string | undefined;
  /** Whether a file exists. Injectable so detection is testable on any OS. */
  readonly exists?: (path: string) => boolean;
}

/** The variable Windows Git Bash reads its command from (see {@link bashOnWindows}). */
export const COMMAND_ENV_VAR = 'ACE_AGENT_COMMAND';

/**
 * Windows Git Bash is an MSYS program: it re-parses its Windows command line with its own rules,
 * which collapse `\\` even inside single quotes, so `-c <command>` would not run the command as
 * written. The command travels in an env var instead, byte for byte, and is `eval`ed — the same as
 * `-c` — after the variable is unset so the command's own children never see it.
 */
const EVAL_FROM_ENV = `ace_cmd=$${COMMAND_ENV_VAR}; unset ${COMMAND_ENV_VAR}; eval "$ace_cmd"`;

const envValue = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined => {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
};

function defaultWhich(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
): (name: string) => string | undefined {
  const paths = platform === 'win32' ? win32 : posix;
  const dirs = (envValue(env, 'PATH', platform) ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter((dir) => dir !== '');
  const extensions =
    platform === 'win32'
      ? (envValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((ext) => ext !== '')
      : [''];
  return (name) => {
    for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = paths.join(dir, `${name}${ext.toLowerCase()}`);
        if (exists(candidate)) return candidate;
      }
    }
    return undefined;
  };
}

/** The WSL launcher (System32/Sysnative/WindowsApps `bash.exe`) — never an agent's shell. */
function isWslLauncher(path: string): boolean {
  const lower = win32.normalize(path).toLowerCase();
  return /\\(system32|sysnative|windowsapps)\\bash\.exe$/.test(lower);
}

/** `<Git>` from wherever git.exe sits: `cmd\`, `bin\`, or `mingw64\bin\` (and its arm/32 kin). */
function gitRoots(gitExe: string): string[] {
  const dir = win32.dirname(gitExe);
  const parent = win32.dirname(dir);
  const base = win32.basename(dir).toLowerCase();
  if (base === 'cmd') return [parent];
  if (base === 'bin') {
    const grand = win32.dirname(parent);
    return /^(mingw64|mingw32|clangarm64|ucrt64|clang64)$/i.test(win32.basename(parent)) ||
      win32.basename(parent).toLowerCase() === 'usr'
      ? [grand]
      : [parent];
  }
  return [parent];
}

function kindOf(path: string): AgentShellKind {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (name === 'powershell' || name === 'pwsh') return 'powershell';
  if (name === 'bash') return 'bash';
  return 'sh';
}

function makeShell(
  path: string,
  kind: AgentShellKind,
  platform: NodeJS.Platform,
  label: string,
): AgentShell {
  if (kind === 'powershell') {
    return {
      kind,
      path,
      label,
      // -EncodedCommand is -Command with the text carried losslessly (UTF-16LE base64).
      argsFor: (command) => [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64'),
      ],
      envFor: () => ({}),
    };
  }
  if (platform === 'win32') {
    return {
      kind,
      path,
      label,
      argsFor: () => ['-c', EVAL_FROM_ENV],
      envFor: (command) => ({ [COMMAND_ENV_VAR]: command }),
    };
  }
  return { kind, path, label, argsFor: (command) => ['-c', command], envFor: () => ({}) };
}

function bashOnWindows(path: string): AgentShell {
  return makeShell(path, 'bash', 'win32', `Git Bash (${path}) on Windows`);
}

export function resolveAgentShell(options: ResolveAgentShellOptions): AgentShell {
  const { platform, env } = options;
  const exists = options.exists ?? existsSync;
  const which = options.which ?? defaultWhich(platform, env, exists);
  const osName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';

  const override = envValue(env, 'ACE_AGENT_SHELL', platform)?.trim();
  if (
    override !== undefined &&
    override !== '' &&
    !(platform === 'win32' && isWslLauncher(override))
  ) {
    const kind = kindOf(override);
    return makeShell(
      override,
      kind,
      platform,
      `${kind} (${override}, from ACE_AGENT_SHELL) on ${osName}`,
    );
  }

  if (platform === 'win32') {
    const git = which('git');
    const roots = git === undefined ? [] : gitRoots(git);
    const programFiles = envValue(env, 'ProgramFiles', platform);
    if (programFiles !== undefined) roots.push(win32.join(programFiles, 'Git'));
    for (const root of roots) {
      for (const candidate of [
        win32.join(root, 'bin', 'bash.exe'),
        win32.join(root, 'usr', 'bin', 'bash.exe'),
      ]) {
        if (!isWslLauncher(candidate) && exists(candidate)) return bashOnWindows(candidate);
      }
    }
    const systemRoot = envValue(env, 'SystemRoot', platform) ?? 'C:\\Windows';
    const installed = win32.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const powershell = exists(installed) ? installed : 'powershell.exe';
    return makeShell(
      powershell,
      'powershell',
      platform,
      `Windows PowerShell (${powershell}) on Windows`,
    );
  }

  if (exists('/bin/bash'))
    return makeShell('/bin/bash', 'bash', platform, `bash (/bin/bash) on ${osName}`);
  return makeShell('/bin/sh', 'sh', platform, `sh (/bin/sh) on ${osName}`);
}

/** Everything `spawn` needs to run `command` in `shell` with `env` (the allowlisted env). */
export function shellInvocation(
  shell: AgentShell,
  command: string,
  env: Readonly<Record<string, string>>,
): { file: string; args: string[]; env: Record<string, string> } {
  return {
    file: shell.path,
    args: shell.argsFor(command),
    env: { ...env, ...shell.envFor(command) },
  };
}
