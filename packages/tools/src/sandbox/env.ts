/**
 * The environment a sandboxed child process is given (FR-TOOL-004, NFR-SEC-04, Arch §22.2).
 *
 * The rule is allow-list, not deny-list. `process.env` in the engine holds whatever the user's
 * shell holds — `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, an `ACE_SESSION_TOKEN` — and a
 * deny-list is a bet that we thought of every name. So nothing is inherited unless it is on
 * {@link SANDBOX_ENV_ALLOWLIST}, which holds only what an interpreter needs to start.
 *
 * Three things are then written over the top:
 *
 * 1. **`HOME`, `USERPROFILE` and the temp vars point at the sandbox.** This is why
 *    `os.path.expanduser('~')` or `os.homedir()` inside sandboxed code cannot reach the real home
 *    folder: there is nothing to reach, `~` *is* the sandbox (TC-TOOL-005).
 * 2. **Every proxy variable points at a closed port** on 127.0.0.1, and `NO_PROXY` is emptied, so
 *    any library that honours the conventional proxy variables fails to connect instead of
 *    reaching the internet.
 * 3. **Package installers are pinned offline** (`PIP_NO_INDEX`, `npm_config_offline`), because
 *    "no network" that still lets `pip install` phone out is not no network.
 *
 * Env alone is not the network control — it is the outermost of three layers. The other two are
 * the PATH shims (`deny-shims.ts`, which stop `curl`) and the per-language preludes
 * (`languages.ts`, which stop `socket` and `node:http`). Docker adds `--network none` on top.
 */

import { ToolError } from '../errors.js';

/** The only names inherited from the engine's own environment. Nothing else crosses. */
export const SANDBOX_ENV_ALLOWLIST: readonly string[] = [
  // Finding the interpreter at all.
  'PATH',
  'Path',
  'PATHEXT',
  // Windows needs these or nothing starts: `cmd.exe`, DLL search, drive letters.
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'ComSpec',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  // Text handling, so output is not mojibake.
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
];

/**
 * A closed port. `connect` to it fails at once with `ECONNREFUSED` rather than hanging, so code
 * that honours the proxy variables fails fast instead of burning the whole `timeoutMs`.
 */
export const SANDBOX_DEAD_PROXY = 'http://127.0.0.1:1';

/** Set in the child so a wrapper, or the code itself, can see which regime it is under. */
export const SANDBOX_MARKER_ENV = 'ACE_SANDBOX';

/** What every layer says when it refuses to let the sandbox reach the network. */
export const NETWORK_DENIED_MESSAGE = 'ACE sandbox: network access is denied';

/**
 * Names that never cross into a child even if some future edit adds them to the allow-list. A
 * second lock on the same door: the allow-list decides what is copied, and this decides what
 * cannot be copied whatever the allow-list says.
 */
const SECRET_SHAPED = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|AUTH|COOKIE/i;

export interface SandboxEnvOptions {
  /** Absolute path of the run's sandbox folder. Becomes `HOME`, `TMPDIR` and the cwd. */
  readonly sandboxDir: string;
  /** Prepended to `PATH`, ahead of everything: where `deny-shims.ts` wrote its refusals. */
  readonly denyShimDir?: string;
  /** Where to inherit from. Defaults to the engine's own environment. */
  readonly source?: Record<string, string | undefined>;
  /** Extra variables the caller wants set. Still filtered by {@link SECRET_SHAPED}. */
  readonly extra?: Record<string, string>;
  readonly platform?: NodeJS.Platform;
}

/**
 * Builds the child's whole environment. Nothing that is not returned here is visible to sandboxed
 * code — `spawn` is always called with this object as `env`, never with `process.env` merged in.
 */
export function sandboxEnv({
  sandboxDir,
  denyShimDir,
  source = process.env,
  extra = {},
  platform = process.platform,
}: SandboxEnvOptions): Record<string, string> {
  if (!sandboxDir || sandboxDir.trim().length === 0) {
    throw new ToolError('denied', 'sandbox', 'A sandboxed process needs a sandbox folder.', {});
  }

  const env: Record<string, string> = {};

  for (const name of SANDBOX_ENV_ALLOWLIST) {
    const value = source[name];
    if (typeof value === 'string' && value.length > 0 && !SECRET_SHAPED.test(name)) {
      env[name] = value;
    }
  }

  if (denyShimDir !== undefined && denyShimDir.length > 0) {
    const separator = platform === 'win32' ? ';' : ':';
    for (const name of ['PATH', 'Path'] as const) {
      const existing = env[name];
      env[name] = existing === undefined ? denyShimDir : `${denyShimDir}${separator}${existing}`;
    }
    // A machine whose environment spelled neither `PATH` nor `Path` still gets the shims.
    if (env.PATH === undefined && env.Path === undefined) env.PATH = denyShimDir;
  }

  // `~` is the sandbox, on both platforms' spellings.
  env.HOME = sandboxDir;
  env.USERPROFILE = sandboxDir;
  env.HOMEDRIVE = '';
  env.HOMEPATH = sandboxDir;
  env.TMPDIR = sandboxDir;
  env.TEMP = sandboxDir;
  env.TMP = sandboxDir;
  env.PWD = sandboxDir;

  // No network, said in every dialect a library might read.
  for (const name of [
    'http_proxy',
    'HTTP_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
    'ftp_proxy',
    'FTP_PROXY',
    'npm_config_proxy',
    'npm_config_https_proxy',
  ]) {
    env[name] = SANDBOX_DEAD_PROXY;
  }
  env.no_proxy = '';
  env.NO_PROXY = '';
  env.PIP_NO_INDEX = '1';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  env.PIP_INDEX_URL = `${SANDBOX_DEAD_PROXY}/simple`;
  env.npm_config_offline = 'true';
  env.npm_config_registry = SANDBOX_DEAD_PROXY;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ALLOW_PROTOCOL = 'none';

  // Interpreter hygiene: no user site-packages, no `.pyc` litter, unbuffered output so a killed
  // process still shows what it had printed.
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONPATH = '';
  env.NODE_PATH = '';
  // Never inherited (it is not on the allow-list) and never set: it would let a caller smuggle
  // flags such as `--max-old-space-size` past the cap the runner passes on the command line.
  delete env.NODE_OPTIONS;

  env[SANDBOX_MARKER_ENV] = '1';

  for (const [name, value] of Object.entries(extra)) {
    if (!SECRET_SHAPED.test(name)) env[name] = value;
  }

  return env;
}
