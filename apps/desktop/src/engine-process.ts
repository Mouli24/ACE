import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type { EngineIpcReady, ShellToEngineMessage } from '@ace/contracts';

/**
 * The packaged app's engine (D296, D298): a bundled `node.exe` running the deployed `apps/server`,
 * with an IPC channel. Electron-free, so it is tested with real Node and a scripted fake engine.
 *
 * The protocol is `@ace/contracts`' (D296): the engine sends `{ type: 'ready', url, port, token }`
 * once it can shut down cleanly; the shell sends `{ type: 'shutdown' }` to stop it, and a shell
 * that dies closes the channel, which the engine treats the same way.
 */

export type EngineReady = Omit<EngineIpcReady, 'type'>;

/** The engine stopped, or never said it was ready; `stderr` is its last lines, for the dialog. */
export class EngineStartError extends Error {
  override readonly name = 'EngineStartError';

  constructor(
    message: string,
    readonly stderr: string[],
  ) {
    super(message);
  }
}

/**
 * `EngineIpcReadySchema` (`@ace/contracts`) checked by hand: the shell has no runtime dependencies
 * (D292), so it cannot run the Zod schema; `engine-process.test.ts` checks the two agree.
 */
export function parseReady(message: unknown): EngineReady | undefined {
  if (message === null || typeof message !== 'object') return undefined;
  const m = message as Record<string, unknown>;
  if (m['type'] !== 'ready') return undefined;
  const { url, port, token } = m;
  if (typeof url !== 'string' || typeof token !== 'string' || token === '') return undefined;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { url: url.replace(/\/+$/, ''), port, token };
}

export interface EngineExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export type ShutdownResult = 'clean' | 'killed' | 'already-exited';

export interface StartEngineProcessOptions {
  /** The bundled `node.exe` — real Node, never Electron (D292). */
  nodePath: string;
  /** The deployed engine's `dist/main.js`. */
  mainPath: string;
  cwd: string;
  env: Record<string, string | undefined>;
  /** How long `ready` may take before the start counts as failed. */
  readyTimeoutMs?: number;
  /** How many stderr lines are kept for an error dialog. */
  tailLines?: number;
  /** Kill the engine and everything it started (a CLI run, an MCP server). */
  killTree?: (child: ChildProcess) => void;
}

export interface EngineProcess {
  readonly pid: number | undefined;
  /** Resolves on `ready`; rejects with {@link EngineStartError} on an exit or a timeout first. */
  readonly ready: Promise<EngineReady>;
  /** Resolves when the process has exited, for whatever reason. */
  readonly exited: Promise<EngineExit>;
  /** The last stderr lines. */
  tail(): string[];
  /**
   * Ask the engine to stop (`shutdown`: the same path as Ctrl-C — runs are HALTED `shutdown`, the
   * database closes), and kill it if it has not exited within `timeoutMs`.
   */
  shutdown(timeoutMs?: number): Promise<ShutdownResult>;
}

const defaultKillTree = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // `child.kill()` is TerminateProcess on Windows and leaves the engine's own children behind.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
};

export function startEngineProcess(options: StartEngineProcessOptions): EngineProcess {
  const tailLines = options.tailLines ?? 40;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const killTree = options.killTree ?? defaultKillTree;

  // Never ELECTRON_RUN_AS_NODE: this is a real Node binary, and the variable would leak into every
  // process the engine starts.
  const env = { ...options.env };
  delete env['ELECTRON_RUN_AS_NODE'];

  const lines: string[] = [];
  const remember = (chunk: Buffer | string): void => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === '') continue;
      lines.push(line);
      if (lines.length > tailLines) lines.shift();
    }
  };

  const child = spawn(options.nodePath, [options.mainPath], {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    // On Windows libuv puts every child in a kill-on-close job object, so a shell that dies (End
    // task) took the engine down with a hard kill — runs left RUNNING, recovered later as `crash`.
    // Detached, the engine outlives the shell by the moment it takes to see the IPC channel close,
    // and runs the same shutdown Ctrl-C does (D296). Its own children stay in its job and go with
    // it. Every spawn in the engine sets windowsHide, so no console window appears.
    detached: process.platform === 'win32',
  });
  child.stderr?.on('data', remember);
  // stdout carries the ready banner — with the token in it — so it is drained, never kept.
  child.stdout?.resume();

  let hasExited = false;
  const exited = new Promise<EngineExit>((resolve) => {
    child.once('exit', (code, signal) => {
      hasExited = true;
      resolve({ code, signal });
    });
    child.once('error', (error) => {
      // Spawning failed (no node.exe): there will be no 'exit'.
      remember(error.message);
      hasExited = true;
      resolve({ code: null, signal: null });
    });
  });

  const ready = new Promise<EngineReady>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new EngineStartError(
          `The engine did not start within ${Math.round(readyTimeoutMs / 1000)} s.`,
          [...lines],
        ),
      );
      killTree(child);
    }, readyTimeoutMs);

    child.on('message', (message) => {
      const parsed = parseReady(message);
      if (parsed === undefined) return;
      clearTimeout(timer);
      resolve(parsed);
    });

    void exited.then(({ code, signal }) => {
      clearTimeout(timer);
      const how = code === null ? (signal ?? 'it could not be started') : `exit code ${code}`;
      // A no-op once `ready` has resolved.
      reject(new EngineStartError(`The engine stopped before it was ready (${how}).`, [...lines]));
    });
  });
  // `ready` may be rejected long after anyone stopped awaiting it (a timeout after a quit).
  ready.catch(() => undefined);

  return {
    pid: child.pid,
    ready,
    exited,
    tail: () => [...lines],
    async shutdown(timeoutMs = 10_000) {
      if (hasExited) return 'already-exited';
      const message: ShellToEngineMessage = { type: 'shutdown' };
      try {
        child.send(message);
      } catch {
        // The channel is gone; the engine is stopping on `disconnect` already, or is wedged.
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([exited.then(() => 'exited' as const), timedOut]);
      clearTimeout(timer);
      if (outcome === 'exited') return 'clean';
      killTree(child);
      await exited;
      return 'killed';
    },
  };
}
