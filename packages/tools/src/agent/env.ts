/**
 * Agentic nodes, Phase 1 (FR-TOOL-008, BR-07): the environment an agent's command runs with. It is
 * built from an allowlist, never from the engine's own environment minus a denylist: a provider key,
 * the engine's session token or any `ACE_*` setting the engine holds never reaches a command the
 * model wrote (`agentic-nodes-prompt.md`, Command runner).
 */

/** The Windows starting list. Matched case-insensitively: the real key is often `Path`. */
export const WINDOWS_ENV_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'TEMP',
  'TMP',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'USERNAME',
  'COMPUTERNAME',
] as const;

/** The POSIX list, exact case. */
export const POSIX_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR'] as const;

/** Always set: a tool that would prompt fails fast instead (stdin is closed too). */
const FIXED: Readonly<Record<string, string>> = {
  CI: '1',
  GIT_TERMINAL_PROMPT: '0',
};

/**
 * The allowlisted part of `source`, plus `CI=1` and `GIT_TERMINAL_PROMPT=0`. On Windows a key keeps
 * the spelling `source` has (`Path`, `SYSTEMROOT`), so the child sees exactly one of each.
 */
export function agentEnv(
  source: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (platform === 'win32') {
    const wanted = new Set<string>(WINDOWS_ENV_ALLOWLIST.map((key) => key.toUpperCase()));
    const taken = new Set<string>();
    for (const [key, value] of Object.entries(source)) {
      const upper = key.toUpperCase();
      if (value === undefined || !wanted.has(upper) || taken.has(upper)) continue;
      taken.add(upper);
      env[key] = value;
    }
  } else {
    for (const key of POSIX_ENV_ALLOWLIST) {
      const value = source[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return { ...env, ...FIXED };
}
