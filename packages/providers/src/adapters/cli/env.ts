import type { CliProviderType } from '@ace/contracts';

/**
 * D-093 (BR-07, FR-PRV-002, NFR-SEC-04): the environment a coding-agent CLI runs with. Like an
 * agent's command (D347), it is built from an allowlist, never from the engine's own environment
 * minus a denylist: another provider's key, cloud credentials, the engine's session token or any
 * `ACE_*` setting never reach Claude Code, Codex or Gemini — nor, through them, the model or a
 * command it runs. What does reach a CLI is what it needs to run as the person: the system's paths
 * and folders, a proxy, and its **own** sign-in and config variables, no other CLI's.
 */

/** The Windows starting list (D347's). Matched case-insensitively: the real key is often `Path`. */
const WINDOWS_BASE = [
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

/** The POSIX starting list (D347's), plus the XDG folders a CLI keeps its sign-in under. */
const POSIX_BASE = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
] as const;

/** A network the person reaches only through a proxy, or with their own certificate authority. */
const NETWORK = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const;

/** Each CLI's own sign-in and configuration variables, and nothing of the others'. */
export const CLI_OWN_ENV: Readonly<Record<CliProviderType, readonly string[]>> = {
  claude_code: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_GIT_BASH_PATH',
    'CLAUDE_CODE_USE_VERTEX',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'CLOUD_ML_REGION',
  ],
  codex_cli: ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  gemini_cli: [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_MODEL',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ],
};

/**
 * The allowlisted part of `source` for one CLI — or, with no `type` (a sign-in probe that may
 * reach any of them), for every CLI's own variables. On Windows a key keeps the spelling `source`
 * has (`Path`, `SYSTEMROOT`) and each name is taken once whatever its case; a proxy variable is
 * taken in either case on every platform (`https_proxy` is as common as `HTTPS_PROXY`).
 */
export function cliEnv(
  source: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  type?: CliProviderType,
): Record<string, string> {
  const own =
    type === undefined ? Object.values(CLI_OWN_ENV).flat() : [...CLI_OWN_ENV[type]];
  const base = platform === 'win32' ? WINDOWS_BASE : POSIX_BASE;
  const env: Record<string, string> = {};
  if (platform === 'win32') {
    const wanted = new Set<string>([...base, ...NETWORK, ...own].map((key) => key.toUpperCase()));
    const taken = new Set<string>();
    for (const [key, value] of Object.entries(source)) {
      const upper = key.toUpperCase();
      if (value === undefined || !wanted.has(upper) || taken.has(upper)) continue;
      taken.add(upper);
      env[key] = value;
    }
    return env;
  }
  const exact = new Set<string>([...base, ...own]);
  const network = new Set<string>(NETWORK.map((key) => key.toUpperCase()));
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (exact.has(key) || network.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}
