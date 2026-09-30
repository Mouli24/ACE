import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type SandboxSpec } from '@ace/engine';
import { type SandboxLanguage } from '@ace/contracts';

import { writeDenyShims } from './deny-shims.js';
import { NETWORK_DENIED_MESSAGE, sandboxEnv } from './env.js';

/**
 * Turns `{ language, code }` into a {@link SandboxSpec} the child-process runner can execute
 * (FR-TOOL-004, D13). Three languages (§2.2): `javascript`, `python`, `shell`.
 *
 * Each run gets its scaffolding written into `<sandbox>/.ace-run/` — dot-prefixed, so the produced
 * files collector skips it (as it skips `.ace-deny`). The network is denied in three layers, of
 * which this file adds the third: the environment's dead proxies ({@link sandboxEnv}), the PATH
 * deny-shims that stop `curl` ({@link writeDenyShims}), and a per-language prelude that stops the
 * interpreter's own sockets — `require('node:http')` in JS, `socket` in Python. Shell has no prelude
 * and leans on the first two layers, which is why the shims exist.
 *
 * `node` runs from `process.execPath` (this engine's own binary, always present and absolute, so
 * the deny-shim PATH cannot hide it) with `--max-old-space-size` for the memory cap. `python` is
 * detected; `shell` is `/bin/sh` on POSIX and `cmd.exe` on Windows.
 */

/** Folder inside the sandbox that holds the prelude and the code file. Dot-prefixed → not collected. */
export const RUN_DIR_NAME = '.ace-run';

/** Default V8 old-space cap for the `javascript` runner (MB). Docker gives a hard cap; this is soft. */
export const DEFAULT_MAX_OLD_SPACE_MB = 128;

/** The JS prelude, loaded with `-r` before the user's module, denying the interpreter's own network. */
const JS_PRELUDE = `'use strict';
// ACE sandbox: deny the interpreter's own network (NFR-SEC-04). Defense in depth beside the dead
// proxy environment and the PATH deny-shims; Docker's --network none is the hard guarantee.
//
// Surgical on purpose: only the connection-*initiating* calls are replaced. Overriding the Socket
// class or dns.lookup breaks Node's own bootstrap (process.stdout is a net.Socket), so those are
// left alone and Socket.prototype.connect is neutered instead.
const MESSAGE = ${JSON.stringify(NETWORK_DENIED_MESSAGE)};
const deny = () => {
  throw new Error(MESSAGE);
};
function patch(mod, names) {
  for (const name of names) {
    if (mod && typeof mod[name] === 'function') {
      try {
        mod[name] = deny;
      } catch {
        // A read-only export; the other layers still hold.
      }
    }
  }
}
try {
  const net = require('node:net');
  patch(net, ['connect', 'createConnection']);
  if (net.Socket && net.Socket.prototype) net.Socket.prototype.connect = deny;
} catch {}
try { patch(require('node:http'), ['request', 'get']); } catch {}
try { patch(require('node:https'), ['request', 'get']); } catch {}
try {
  globalThis.fetch = () => Promise.reject(new Error(MESSAGE));
} catch {}
`;

/** The Python prelude, prepended to the user's code, denying `socket` before anything runs. */
const PYTHON_PRELUDE = `# ACE sandbox: deny the interpreter's own network (NFR-SEC-04).
import socket as _ace_socket
def _ace_denied(*_args, **_kwargs):
    raise OSError(${JSON.stringify(NETWORK_DENIED_MESSAGE)})
_ace_socket.socket = _ace_denied
_ace_socket.create_connection = _ace_denied
`;

export interface PreparedCodeRun {
  readonly spec: SandboxSpec;
}

export interface PrepareCodeRunOptions {
  readonly sandboxDir: string;
  readonly language: SandboxLanguage;
  readonly code: string;
  readonly timeoutMs: number;
  readonly maxOldSpaceMb?: number;
  readonly platform?: NodeJS.Platform;
  /** For tests: pin the node binary. Defaults to this process's own node. */
  readonly nodePath?: string;
  /** For tests: pin the python interpreter, skipping detection. */
  readonly pythonPath?: string | null;
}

/**
 * Node's own permission model, confining a `javascript` run's filesystem to its sandbox folder
 * (TC-TOOL-005, NFR-SEC-04, D-068).
 *
 * Without it the child could read — and write — anything the engine's user can: `cwd` and a remapped
 * `HOME` only move where *relative* paths and `~` land, and an absolute path walked straight past
 * them. Under `--permission` the runtime refuses every fs call outside the granted folders with
 * `ERR_ACCESS_DENIED`, and — with no `--allow-child-process`, `--allow-worker` or `--allow-addons` —
 * refuses spawning a process, a worker or a native addon too, which are the ways round any
 * in-process rule. A granted directory covers its whole subtree.
 *
 * The flag's name depends on the Node that runs the sandbox (it is `process.execPath`, the engine's
 * own): `--permission` from 22.13 / 23.5 on, `--experimental-permission` before (engines: >= 20.11),
 * with that release's ExperimentalWarning silenced so it does not land in every run's stderr. The
 * folder's real path is granted beside the given one, because the child resolves relative paths
 * against its real `cwd` (a symlinked temp folder, an 8.3 short name on Windows).
 */
export function nodePermissionFlags(sandboxDir: string, version: string = process.versions.node): string[] {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const stable = major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 13);

  let real = sandboxDir;
  try {
    real = realpathSync.native(sandboxDir);
  } catch {
    // Not there yet: nothing to resolve, and the given path is all there is to grant.
  }
  const folders = real === sandboxDir ? [sandboxDir] : [sandboxDir, real];

  return [
    stable ? '--permission' : '--experimental-permission',
    ...(stable ? [] : ['--disable-warning=ExperimentalWarning']),
    ...folders.flatMap((folder) => [`--allow-fs-read=${folder}`, `--allow-fs-write=${folder}`]),
  ];
}

/** Whether a `python3`/`python` interpreter answers `--version` quickly. Cached per resolved name. */
function detectPython(platform: NodeJS.Platform): string | null {
  const candidates = platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['--version'], { timeout: 3000, encoding: 'utf8' });
      if (probe.status === 0 && !probe.error) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Writes the scaffolding and returns the spec. Throws nothing itself; a missing Python interpreter
 * comes back as `pythonAvailable: false` so the tool can report `unavailable` rather than a spawn
 * error the model cannot read.
 */
export function prepareCodeRun(
  options: PrepareCodeRunOptions,
): { spec: SandboxSpec } | { unavailable: 'python' } {
  const {
    sandboxDir,
    language,
    code,
    timeoutMs,
    maxOldSpaceMb = DEFAULT_MAX_OLD_SPACE_MB,
    platform = process.platform,
    nodePath = process.execPath,
  } = options;

  const runDir = join(sandboxDir, RUN_DIR_NAME);
  mkdirSync(runDir, { recursive: true });
  const denyShimDir = writeDenyShims(sandboxDir, platform);
  const env = sandboxEnv({ sandboxDir, denyShimDir, platform });

  if (language === 'javascript') {
    // `.cjs`, not `.mjs`: a snippet that reaches for `require('fs')` is the common case, and `-r`
    // preloads the prelude into the same CommonJS module cache it then patches, so the network
    // overrides actually take on the modules the code goes on to require.
    const preludePath = join(runDir, 'prelude.cjs');
    const mainPath = join(runDir, 'main.cjs');
    writeFileSync(preludePath, JS_PRELUDE, 'utf8');
    writeFileSync(mainPath, code, 'utf8');
    return {
      spec: {
        command: nodePath,
        args: [
          `--max-old-space-size=${maxOldSpaceMb}`,
          ...nodePermissionFlags(sandboxDir),
          '-r',
          preludePath,
          mainPath,
        ],
        workingDirectory: sandboxDir,
        timeoutMs,
        env,
      },
    };
  }

  if (language === 'python') {
    const interpreter = options.pythonPath !== undefined ? options.pythonPath : detectPython(platform);
    if (interpreter === null) return { unavailable: 'python' };
    const mainPath = join(runDir, 'main.py');
    writeFileSync(mainPath, `${PYTHON_PRELUDE}\n${code}`, 'utf8');
    return {
      spec: { command: interpreter, args: [mainPath], workingDirectory: sandboxDir, timeoutMs, env },
    };
  }

  // shell
  if (platform === 'win32') {
    const scriptPath = join(runDir, 'main.cmd');
    writeFileSync(scriptPath, `@echo off\r\n${code}\r\n`, 'utf8');
    const comspec = env.COMSPEC ?? env.ComSpec ?? 'cmd.exe';
    return {
      spec: { command: comspec, args: ['/d', '/c', scriptPath], workingDirectory: sandboxDir, timeoutMs, env },
    };
  }

  const scriptPath = join(runDir, 'main.sh');
  writeFileSync(scriptPath, code, 'utf8');
  return {
    spec: { command: '/bin/sh', args: [scriptPath], workingDirectory: sandboxDir, timeoutMs, env },
  };
}
