import { spawn } from 'node:child_process';

import { killTree } from '../sandbox/runner.js';
import { MODEL_OUTPUT_CHARS, OutputBuffer } from './output.js';
import {
  type AgentCommandObserver,
  type BackgroundProcesses,
  type BackgroundSnapshot,
} from './session.js';
import { shellInvocation, type AgentShell } from './shell.js';

/**
 * Agentic nodes, Phase 1 (FR-TOOL-008): the run's background commands — `run_command` with
 * `background: true`, read with `command_output`, ended with `kill_command`, and all ended by
 * `killAll` when the run ends, is cancelled or the engine shuts down (`agentic-nodes-prompt.md`,
 * Command runner: tracked per run, not per step, so node B can use the server node A started).
 *
 * Each runs in the agent shell with the allowlisted env, stdin closed, no console window, and on
 * POSIX as the leader of its own process group, so a kill reaches everything it started. On
 * Windows the kill is `taskkill /T /F`, which follows the tree from the shell's pid — so a
 * grandchild whose shell has already exited (orphaned) is out of its reach.
 */

/** Characters retained per stream between two `command_output` calls (head + rolling tail). */
const DEFAULT_RETAIN_CHARS = 1_000_000;
/** How long `kill`/`killAll` wait for a killed process to be gone before answering anyway. */
const DEFAULT_KILL_WAIT_MS = 3_000;

export interface BackgroundProcessesOptions {
  readonly platform?: NodeJS.Platform;
  /** The env every background command runs with — already allowlisted (`agentEnv`). */
  readonly env: Readonly<Record<string, string>>;
  readonly shell: AgentShell;
  readonly now?: () => number;
  readonly retainChars?: number;
  /** What one `command_output` returns per stream, at most. Default 30 000. */
  readonly returnChars?: number;
  readonly killWaitMs?: number;
  /** PG-5.3: each command's output and end, for Forge's Terminal and Processes list. */
  readonly observer?: AgentCommandObserver;
}

/** One background command as the engine lists it (not sent to a model). */
export interface BackgroundProcessInfo {
  readonly processId: string;
  readonly nodeId: string;
  readonly command: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly running: boolean;
  readonly exitCode: number | null;
}

export interface AgentBackgroundProcesses extends BackgroundProcesses {
  list(): BackgroundProcessInfo[];
}

interface Tracked {
  readonly processId: string;
  readonly nodeId: string;
  readonly command: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly stdout: OutputBuffer;
  readonly stderr: OutputBuffer;
  running: boolean;
  exitCode: number | null;
  readonly exited: Promise<void>;
}

/** `taskkill /pid <pid> /T /F`, resolved once taskkill has finished (or could not start). */
function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        .on('error', () => resolve())
        .on('exit', () => resolve());
    } catch {
      resolve();
    }
  });
}

export function createBackgroundProcesses(
  options: BackgroundProcessesOptions,
): AgentBackgroundProcesses {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const retain = options.retainChars ?? DEFAULT_RETAIN_CHARS;
  const returnChars = options.returnChars ?? MODEL_OUTPUT_CHARS;
  const killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS;
  const processes = new Map<string, Tracked>();
  let counter = 0;

  const bounded = (work: Promise<unknown>): Promise<void> =>
    Promise.race([
      work.then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, killWaitMs).unref()),
    ]);

  const killOne = async (tracked: Tracked): Promise<boolean> => {
    const wasRunning = tracked.running;
    if (tracked.pid === undefined) return wasRunning;
    if (platform === 'win32') {
      if (!wasRunning) return false;
      // Wait for taskkill itself, not only the shell: the shell's exit is reported before the rest
      // of its tree is gone, and "killed" should mean nothing it started still holds the folder.
      await bounded(Promise.all([taskkillTree(tracked.pid), tracked.exited]));
      return true;
    }
    // On POSIX the group may outlive its leader, so a finished shell's group is still signalled.
    killTree(tracked.pid, platform);
    if (wasRunning) await bounded(tracked.exited);
    return wasRunning;
  };

  return {
    start({ nodeId, command, cwd }) {
      counter += 1;
      const processId = `bg_${counter}`;
      const spec = shellInvocation(options.shell, command, options.env);
      const stdout = new OutputBuffer(retain);
      const stderr = new OutputBuffer(retain);
      let markExited: () => void = () => undefined;
      const exited = new Promise<void>((resolve) => {
        markExited = resolve;
      });

      const child = spawn(spec.file, spec.args, {
        cwd,
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: lead a process group so one kill reaches everything the command started.
        detached: platform !== 'win32',
      });
      const tracked: Tracked = {
        processId,
        nodeId,
        command,
        pid: child.pid,
        startedAt: now(),
        stdout,
        stderr,
        running: true,
        exitCode: null,
        exited,
      };
      processes.set(processId, tracked);
      const watch = options.observer?.started({
        nodeId,
        command,
        cwd,
        background: true,
        processId,
      });

      const end = (code: number | null, failed = false): void => {
        if (!tracked.running) return;
        tracked.running = false;
        tracked.exitCode = code;
        watch?.exited(code, failed);
        markExited();
      };
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout.push(chunk);
        watch?.output('stdout', chunk);
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr.push(chunk);
        watch?.output('stderr', chunk);
      });
      child.stdout.on('error', () => undefined);
      child.stderr.on('error', () => undefined);
      child.on('error', (error) => {
        if (child.pid === undefined) {
          const message = `Could not start the shell: ${error.message}\n`;
          stderr.push(message);
          watch?.output('stderr', message);
          end(null, true);
        }
      });
      child.on('exit', (code) => end(code));
      return { processId };
    },

    output(processId): BackgroundSnapshot | undefined {
      const tracked = processes.get(processId);
      if (tracked === undefined) return undefined;
      return {
        processId,
        command: tracked.command,
        nodeId: tracked.nodeId,
        stdout: tracked.stdout.take(returnChars),
        stderr: tracked.stderr.take(returnChars),
        running: tracked.running,
        exitCode: tracked.exitCode,
      };
    },

    async kill(processId) {
      const tracked = processes.get(processId);
      return tracked === undefined ? false : killOne(tracked);
    },

    async killAll() {
      await Promise.all([...processes.values()].map((tracked) => killOne(tracked)));
    },

    list() {
      return [...processes.values()].map((tracked) => ({
        processId: tracked.processId,
        nodeId: tracked.nodeId,
        command: tracked.command,
        pid: tracked.pid,
        startedAt: tracked.startedAt,
        running: tracked.running,
        exitCode: tracked.exitCode,
      }));
    },
  };
}
