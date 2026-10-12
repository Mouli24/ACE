import {
  PACKAGE_MANAGERS,
  PROCESS_OUTPUT_MAX_CHARS,
  PROCESS_RECENT_MAX,
  PROCESS_RUNNING_MAX,
  type PackageManager,
  type ProcessDetail,
  type ProcessStartRequest,
  type ProcessStream,
  type ProcessSummary,
  type ProjectScript,
  type ProjectScripts,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import type { MockDb } from './db';

/**
 * The terminal's processes on the mock engine (D301, design §6.3), so the web app, its tests and
 * e2e run with zero env vars. Nothing is spawned; each command plays a script (see the table in
 * the Forge Phase 2 plan, Task 11). Frames go out on the project scope, transient, as the
 * engine's do, and everything lives in memory: a reload is an engine restart.
 */

export class MockProcessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The engine's refusals, word for word (`packages/engine/src/processes/errors.ts`). */
export const MOCK_MESSAGES = {
  terminal_disabled:
    "The terminal is off for this project. Turn it on in the project's settings to run commands.",
  terminal_restricted:
    "This project runs only its own package.json scripts in the terminal. Pick a script, or allow every command in the project's settings.",
  process_limit: `This project already runs ${PROCESS_RUNNING_MAX} processes. Stop one before starting another.`,
  process_not_running: 'That process has finished, so it reads no more input.',
  engine_stopping: 'The engine is shutting down; the command was not started.',
} as const;

const LOCKFILES: ReadonlyArray<readonly [file: string, manager: PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

/** A script name every shell reads as one word: the tools reader's `SAFE_SCRIPT_NAME`. */
const SAFE_SCRIPT_NAME = /^[\w@][\w:.@/+-]{0,199}$/;

interface Run {
  summary: ProcessSummary;
  output: string;
  truncated: boolean;
  order: number;
  /** Set when it ends; the recent-20 list is pruned by it, as the engine's is. */
  finishOrder: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  /** What `ask` does with the next line typed to it. */
  onLine: ((line: string) => void) | undefined;
  /** Typed text not yet ended by a newline. */
  partial: string;
}

export interface MockProcessesOptions {
  /** How often `serve` prints a line. */
  tickMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A typed command's label: one line of it, at most 80 characters, as the engine's `labelOf`. */
const labelOf = (command: string): string => {
  const line = command.trim().replace(/\s+/g, ' ');
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
};

const outside = (): MockProcessError =>
  new MockProcessError(403, 'outside_project', 'That path is outside the project folder.');

export class MockProcesses {
  private readonly runs = new Map<string, Run>();
  private order = 0;
  private finishes = 0;
  /** Set by `stopAll`, as the engine's shutdown sets it: nothing starts until `reset`. */
  private closed = false;
  private readonly tickMs: number;

  constructor(
    private readonly db: MockDb,
    options: MockProcessesOptions = {},
  ) {
    this.tickMs = options.tickMs ?? 500;
  }

  /** Forget every process, cancel every timer and open again (tests, `__aceMock.reset`). */
  reset(): void {
    for (const run of this.runs.values()) this.clearTimers(run);
    this.runs.clear();
    this.closed = false;
  }

  scripts(projectId: string): ProjectScripts {
    const fs = this.db.filesOf(projectId);
    const file = fs['package.json'];
    let manifest: unknown;
    try {
      manifest =
        file?.kind === 'file'
          ? (JSON.parse(file.content.replace(/^\uFEFF/, '')) as unknown)
          : undefined;
    } catch {
      manifest = undefined;
    }
    const scripts: ProjectScript[] = [];
    if (isRecord(manifest) && isRecord(manifest['scripts'])) {
      for (const [name, command] of Object.entries(manifest['scripts'])) {
        // As the engine's reader: a name a shell would read as code, and __proto__, are never offered.
        if (typeof command === 'string' && SAFE_SCRIPT_NAME.test(name) && name !== '__proto__') {
          scripts.push({ name, command });
        }
      }
    }
    const field = isRecord(manifest) ? manifest['packageManager'] : undefined;
    const named =
      typeof field === 'string'
        ? PACKAGE_MANAGERS.find((manager) => manager === field.split('@')[0])
        : undefined;
    const locked = LOCKFILES.find(([lockfile]) => fs[lockfile]?.kind === 'file')?.[1];
    return { packageManager: named ?? locked ?? 'npm', scripts };
  }

  /** The engine's checks, in the engine's order: off, the form, shutting down, the limit, the folder. */
  start(projectId: string, request: ProcessStartRequest): { processId: string } {
    const project = this.db.getProject(projectId);
    if (project === undefined) throw new MockProcessError(404, 'not_found', 'Project not found.');
    const trust = project.terminal ?? 'on';
    if (trust === 'off') {
      throw new MockProcessError(403, 'terminal_disabled', MOCK_MESSAGES.terminal_disabled);
    }
    let command: string;
    let label: string;
    let requested: string;
    if ('script' in request) {
      const known = this.scripts(projectId);
      if (!known.scripts.some((script) => script.name === request.script)) {
        throw new MockProcessError(404, 'not_found', `Script "${request.script}" was not found.`);
      }
      command = `${known.packageManager} run ${request.script}`;
      label = request.label ?? request.script;
      // A script runs in the project root, always (D301 decision 5).
      requested = '';
    } else {
      if (trust === 'scripts') {
        throw new MockProcessError(403, 'terminal_restricted', MOCK_MESSAGES.terminal_restricted);
      }
      command = request.command;
      label = request.label ?? labelOf(request.command);
      requested = request.cwd ?? '';
    }
    if (this.closed) {
      throw new MockProcessError(503, 'engine_stopping', MOCK_MESSAGES.engine_stopping);
    }
    if (this.running(projectId).length >= PROCESS_RUNNING_MAX) {
      throw new MockProcessError(409, 'process_limit', MOCK_MESSAGES.process_limit, {
        max: PROCESS_RUNNING_MAX,
      });
    }
    const cwd = this.checkCwd(projectId, requested);
    this.order += 1;
    const run: Run = {
      summary: {
        id: newId(),
        projectId,
        label,
        command,
        cwd,
        status: 'running',
        exitCode: null,
        signal: null,
        startedAt: new Date().toISOString(),
      },
      output: '',
      truncated: false,
      order: this.order,
      finishOrder: 0,
      timers: [],
      onLine: undefined,
      partial: '',
    };
    this.runs.set(run.summary.id, run);
    // After the 201 is on its way, as a real process's first output would be.
    this.later(run, 0, () => this.play(run, command));
    return { processId: run.summary.id };
  }

  input(projectId: string, processId: string, data: string): void {
    const run = this.find(projectId, processId);
    if (run.summary.status !== 'running') {
      throw new MockProcessError(409, 'process_not_running', MOCK_MESSAGES.process_not_running, {
        processId,
      });
    }
    run.partial += data;
    this.drain(run);
  }

  /** Lines wait in the pipe, as a real stdin buffers them, until the program reads one. */
  private drain(run: Run): void {
    let newline = run.partial.indexOf('\n');
    while (newline !== -1 && run.onLine !== undefined) {
      const line = run.partial.slice(0, newline).replace(/\r$/, '');
      run.partial = run.partial.slice(newline + 1);
      run.onLine(line);
      newline = run.partial.indexOf('\n');
    }
  }

  stop(projectId: string, processId: string): void {
    const run = this.find(projectId, processId);
    if (run.summary.status === 'running') this.end(run, 'exited', null, 'SIGKILL');
  }

  stopProject(projectId: string): void {
    for (const run of this.running(projectId)) this.end(run, 'exited', null, 'SIGKILL');
  }

  /** A deleted project's records go, with their timers (the engine's `forgetProject`). */
  forgetProject(projectId: string): void {
    for (const [id, run] of [...this.runs]) {
      if (run.summary.projectId !== projectId) continue;
      this.clearTimers(run);
      this.runs.delete(id);
    }
  }

  /** The engine shutting down (FR-SYS-008): every process stops, and nothing starts again. */
  stopAll(): void {
    this.closed = true;
    for (const run of [...this.runs.values()]) {
      if (run.summary.status === 'running') this.end(run, 'exited', null, 'SIGKILL');
    }
  }

  list(projectId: string): ProcessSummary[] {
    return [...this.runs.values()]
      .filter((run) => run.summary.projectId === projectId)
      .sort(
        (a, b) =>
          Number(b.summary.status === 'running') - Number(a.summary.status === 'running') ||
          b.order - a.order,
      )
      .map((run) => ({ ...run.summary }));
  }

  get(projectId: string, processId: string): ProcessDetail {
    const run = this.find(projectId, processId);
    return { ...run.summary, output: run.output, truncated: run.truncated };
  }

  private find(projectId: string, processId: string): Run {
    const run = this.runs.get(processId);
    if (run === undefined || run.summary.projectId !== projectId) {
      throw new MockProcessError(404, 'not_found', `Process ${processId} was not found.`);
    }
    return run;
  }

  private running(projectId: string): Run[] {
    return [...this.runs.values()].filter(
      (run) => run.summary.projectId === projectId && run.summary.status === 'running',
    );
  }

  /**
   * The engine's confinement, in miniature (FR-GIT-008), answering the folder as the engine's
   * `normaliseCwd` records it: forward slashes, no `.` or empty segments, `..` folded into its
   * parent, no trailing slash, `''` for the root. A `..` that climbs above the root is outside.
   */
  private checkCwd(projectId: string, cwd: string): string {
    const slashed = cwd.split('\\').join('/');
    if (
      slashed.includes('\u0000') ||
      slashed.startsWith('/') ||
      /^[A-Za-z]:/.test(slashed) ||
      slashed.startsWith('~')
    ) {
      throw outside();
    }
    const parts: string[] = [];
    for (const segment of slashed.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        if (parts.length === 0) throw outside();
        parts.pop();
      } else {
        parts.push(segment);
      }
    }
    const clean = parts.join('/');
    if (clean === '') return '';
    if (parts.some((segment) => segment.toLowerCase() === '.git')) {
      throw new MockProcessError(
        403,
        'protected_path',
        'Forge does not read anything inside .git/.',
      );
    }
    if (this.db.filesOf(projectId)[clean]?.kind !== 'folder') {
      throw new MockProcessError(400, 'invalid_path', `${clean} is not a folder in the project.`, {
        path: clean,
      });
    }
    return clean;
  }

  private play(run: Run, command: string): void {
    const line = command.trim();
    const script = /^(npm|pnpm|yarn|bun) run (\S+)$/.exec(line);
    if (script) {
      const body = this.scripts(run.summary.projectId).scripts.find(
        (each) => each.name === script[2],
      );
      if (body === undefined) {
        this.print(run, `mock: no script named "${script[2] ?? ''}"\n`, 'stderr');
        this.end(run, 'exited', 1, null);
        return;
      }
      this.print(run, `\n> ${body.name}\n> ${body.command}\n\n`);
      this.play(run, body.command);
      return;
    }
    const echo = /^echo(?:\s+(.*))?$/.exec(line);
    if (echo) {
      this.print(run, `${echo[1] ?? ''}\n`);
      this.end(run, 'exited', 0, null);
      return;
    }
    if (line === 'node -v' || line === 'node --version') {
      this.print(run, 'v24.0.0\n');
      this.end(run, 'exited', 0, null);
      return;
    }
    if (line === 'serve') {
      this.print(run, 'listening on 3000\n');
      let requests = 0;
      const tick = (): void => {
        requests += 1;
        this.print(run, `GET / 200 (${requests})\n`);
        this.later(run, this.tickMs, tick);
      };
      this.later(run, this.tickMs, tick);
      return;
    }
    if (line === 'ask') {
      this.print(run, 'name? ');
      run.onLine = (name) => {
        run.onLine = undefined;
        this.print(run, `hello ${name}\n`);
        this.end(run, 'exited', 0, null);
      };
      this.drain(run);
      return;
    }
    if (line === 'fail') {
      this.print(run, 'something went wrong\n', 'stderr');
      this.end(run, 'exited', 1, null);
      return;
    }
    if (line === 'broken') {
      this.print(run, 'Could not start: spawn /bin/sh ENOENT\r\n', 'stderr');
      this.end(run, 'failed', null, null);
      return;
    }
    this.print(run, `mock: ${line.split(/\s+/)[0] ?? line}: not found\n`, 'stderr');
    this.end(run, 'exited', 127, null);
  }

  private print(run: Run, data: string, stream: ProcessStream = 'stdout'): void {
    if (run.summary.status !== 'running') return;
    run.output += data;
    if (run.output.length > PROCESS_OUTPUT_MAX_CHARS) {
      run.output = run.output.slice(-PROCESS_OUTPUT_MAX_CHARS);
      run.truncated = true;
    }
    const { projectId, id: processId } = run.summary;
    this.db.emit({
      type: 'process.output',
      payload: { projectId, processId, stream, data },
      scope: 'project',
      projectId,
      transient: true,
    });
  }

  private end(
    run: Run,
    status: 'exited' | 'failed',
    exitCode: number | null,
    signal: string | null,
  ): void {
    if (run.summary.status !== 'running') return;
    this.clearTimers(run);
    run.onLine = undefined;
    this.finishes += 1;
    run.finishOrder = this.finishes;
    Object.assign(run.summary, { status, exitCode, signal, endedAt: new Date().toISOString() });
    const { projectId, id: processId } = run.summary;
    this.db.emit({
      type: 'process.exited',
      payload: { projectId, processId, exitCode, signal, status },
      scope: 'project',
      projectId,
      transient: true,
    });
    const finished = [...this.runs.values()]
      .filter((each) => each.summary.projectId === projectId && each.summary.status !== 'running')

      .sort((a, b) => a.finishOrder - b.finishOrder);
    for (const old of finished.slice(0, Math.max(0, finished.length - PROCESS_RECENT_MAX))) {
      this.runs.delete(old.summary.id);
    }
  }

  private later(run: Run, ms: number, fn: () => void): void {
    run.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(run: Run): void {
    for (const timer of run.timers) clearTimeout(timer);
    run.timers = [];
  }
}
