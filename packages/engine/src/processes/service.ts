import {
  DEFAULT_TERMINAL_TRUST,
  PROCESS_FRAME_MAX_CHARS,
  PROCESS_OUTPUT_BATCH_MS,
  PROCESS_OUTPUT_MAX_CHARS,
  PROCESS_RECENT_MAX,
  PROCESS_RUNNING_MAX,
  type Id,
  type ProcessDetail,
  type ProcessExitedPayload,
  type ProcessOutputPayload,
  type ProcessStartRequest,
  type ProcessStartResponse,
  type ProcessStream,
  type ProcessSummary,
  type Project,
  type ProjectScripts,
} from '@ace/contracts';

import { createBatcher, type Batcher } from '../events/batcher.js';
import type { EventBus } from '../events/index.js';
import { invalidPath, notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { ProcessRunner, Repository, RunningProcess, Scope } from '../ports/index.js';
import {
  processLimit,
  processNotRunning,
  terminalDisabled,
  terminalRestricted,
  unsafeScriptName,
} from './errors.js';

/**
 * Forge's terminal (D301, design §6.3): a person's commands as supervised processes. Every call
 * names a project; a start is governed by the project's trust level (`on` / `scripts` / `off`),
 * while list, get, input and stop always work so a person can stop what runs.
 *
 * Output streams as transient `process.output` frames, batched at 50 ms, and the run ends with a
 * transient `process.exited`. Nothing reaches the database or the event log: the last 1,048,576
 * characters of each process, and the last 20 finished processes per project, live in memory only
 * and are gone when the engine restarts. Agents never use this service.
 */
export interface ProcessService {
  start(projectId: Id, request: ProcessStartRequest): Promise<ProcessStartResponse>;
  /** Writes to stdin; 409 `process_not_running` once it has ended. */
  input(projectId: Id, processId: Id, data: string): Promise<void>;
  /** Kills the whole tree. Stopping a finished process does nothing. */
  stop(projectId: Id, processId: Id): Promise<void>;
  /** Running first, then finished; newest first in each. */
  list(projectId: Id): Promise<ProcessSummary[]>;
  /** The summary and the kept output, for a terminal tab that re-attaches. */
  get(projectId: Id, processId: Id): Promise<ProcessDetail>;
  scripts(projectId: Id): Promise<ProjectScripts>;
  /** Stops every running process of the project; resolves when each has ended. */
  stopProject(projectId: Id): Promise<void>;
  /** Shutdown (FR-SYS-008): stops every running process; resolves when each has ended. */
  stopAll(): Promise<void>;
}

export interface ProcessServiceDeps {
  repository: Repository;
  scope: Scope;
  runner: ProcessRunner;
  bus: EventBus;
  logger: Logger;
  /** Running processes per project; the next start answers 409 `process_limit`. */
  maxRunning?: number;
  /** Output kept per process, in UTF-16 code units. */
  outputCapChars?: number;
  /** Finished processes remembered per project. */
  keepRecent?: number;
  /** How long output collects before it goes out as frames. */
  batchMs?: number;
  /** The most one `process.output` frame carries; a bigger batch goes out as several frames. */
  frameMaxChars?: number;
  now?: () => string;
}

/**
 * A script name every platform's shell reads as one word. It mirrors `SAFE_SCRIPT_NAME` in
 * `packages/tools/src/process/scripts.ts` (the engine never imports `@ace/tools`): the runner
 * already leaves unsafe names out of `scripts()`, and this checks again before a name nears a shell.
 */
const SAFE_SCRIPT_NAME = /^[\w@][\w:.@/+-]{0,199}$/;
const LABEL_MAX = 80;

interface Chunk {
  stream: ProcessStream;
  data: string;
}

interface Supervised {
  summary: ProcessSummary;
  /** Start order: "newest first" even when two start in the same millisecond. */
  order: number;
  output: string;
  truncated: boolean;
  handle: RunningProcess | undefined;
  batcher: Batcher<Chunk>;
  ended: Promise<void>;
  markEnded: () => void;
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** The last `max` UTF-16 code units of `text`, never starting with the second half of a pair. */
export function tailOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(text.length - max);
  return isLowSurrogate(tail.charCodeAt(0)) ? tail.slice(1) : tail;
}

/** `data` in pieces of at most `max` code units, in order, never ending one inside a pair. */
export function framesOf(data: string, max: number): string[] {
  const frames: string[] = [];
  let at = 0;
  while (at < data.length) {
    let end = Math.min(at + max, data.length);
    if (end < data.length && end - 1 > at && isHighSurrogate(data.charCodeAt(end - 1))) end -= 1;
    frames.push(data.slice(at, end));
    at = end;
  }
  return frames;
}

/**
 * A working folder as the list shows it (D301 decision 4): forward slashes, no `.` or empty
 * segments, `..` folded into its parent, no trailing slash, `''` for the root. It is only a label:
 * the runner confines the folder exactly as it was sent, and a refused one is never recorded, so
 * this can never widen what is allowed.
 */
export function normaliseCwd(cwd: string): string {
  const parts: string[] = [];
  for (const segment of cwd.split(/[\\/]/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

/** A typed command's label: one line of it, at most 80 characters. The mock engine mirrors this. */
const labelOf = (command: string): string => {
  const line = command.trim().replace(/\s+/g, ' ');
  return line.length <= LABEL_MAX ? line : `${line.slice(0, LABEL_MAX - 1)}…`;
};

export function createProcessService(deps: ProcessServiceDeps): ProcessService {
  const { repository, scope, runner, bus, logger } = deps;
  const maxRunning = deps.maxRunning ?? PROCESS_RUNNING_MAX;
  const outputCap = deps.outputCapChars ?? PROCESS_OUTPUT_MAX_CHARS;
  const keepRecent = deps.keepRecent ?? PROCESS_RECENT_MAX;
  const batchMs = deps.batchMs ?? PROCESS_OUTPUT_BATCH_MS;
  const frameMax = deps.frameMaxChars ?? PROCESS_FRAME_MAX_CHARS;
  const now = deps.now ?? (() => new Date().toISOString());
  const byProject = new Map<Id, Map<Id, Supervised>>();
  let starts = 0;

  function recordsOf(projectId: Id): Map<Id, Supervised> {
    let records = byProject.get(projectId);
    if (records === undefined) {
      records = new Map();
      byProject.set(projectId, records);
    }
    return records;
  }

  async function existing(projectId: Id): Promise<Project> {
    const project = await repository.projects.get(scope, projectId);
    if (project === null) throw notFound(`Project ${projectId}`);
    return project;
  }

  async function folderOf(projectId: Id): Promise<Project> {
    const project = await existing(projectId);
    if (project.folderPath === '') throw invalidPath('(none)', 'this project has no folder.');
    return project;
  }

  function find(projectId: Id, processId: Id): Supervised {
    const record = byProject.get(projectId)?.get(processId);
    if (record === undefined) throw notFound(`Process ${processId}`);
    return record;
  }

  /**
   * One stream's run of a batch, as frames of at most `frameMax` characters, in order: a flood
   * (`yes`, a verbose build) never becomes a multi-megabyte send the socket must buffer whole.
   */
  function emitOutput(summary: ProcessSummary, chunk: Chunk): void {
    for (const data of framesOf(chunk.data, frameMax)) {
      const payload: ProcessOutputPayload = {
        projectId: summary.projectId,
        processId: summary.id,
        stream: chunk.stream,
        data,
      };
      void bus.emitTransient({ type: 'process.output', payload });
    }
  }

  /** One frame per run of one stream within a batch, so stdout and stderr keep their order. */
  const flushTo =
    (summary: ProcessSummary) =>
    (chunks: Chunk[]): void => {
      let current: Chunk | undefined;
      for (const chunk of chunks) {
        if (current !== undefined && current.stream === chunk.stream) {
          current = { stream: current.stream, data: current.data + chunk.data };
          continue;
        }
        if (current !== undefined) emitOutput(summary, current);
        current = chunk;
      }
      if (current !== undefined) emitOutput(summary, current);
    };

  function keep(record: Supervised, text: string): void {
    record.output += text;
    if (record.output.length > outputCap) record.truncated = true;
    // Trimmed at twice the cap, so a flood of small chunks costs one copy per cap's worth, not one
    // per chunk. Every read takes the tail.
    if (record.output.length > outputCap * 2) record.output = tailOf(record.output, outputCap);
  }

  function prune(projectId: Id): void {
    const records = recordsOf(projectId);
    const finished = [...records.values()]
      .filter((record) => record.summary.status !== 'running')
      .sort((a, b) => a.order - b.order);
    for (const old of finished.slice(0, Math.max(0, finished.length - keepRecent))) {
      records.delete(old.summary.id);
    }
  }

  function end(
    record: Supervised,
    status: 'exited' | 'failed',
    exitCode: number | null,
    signal: string | null,
  ): void {
    if (record.summary.status !== 'running') return;
    // Whatever output is still batched goes out before the end does.
    record.batcher.stop();
    record.summary.status = status;
    record.summary.exitCode = exitCode;
    record.summary.signal = signal;
    record.summary.endedAt = now();
    record.output = tailOf(record.output, outputCap);
    record.handle = undefined;
    const payload: ProcessExitedPayload = {
      projectId: record.summary.projectId,
      processId: record.summary.id,
      exitCode,
      signal,
      status,
    };
    void bus.emitTransient({ type: 'process.exited', payload });
    record.markEnded();
    prune(record.summary.projectId);
  }

  async function stopRunning(records: Iterable<Supervised>): Promise<void> {
    const waits: Array<Promise<void>> = [];
    for (const record of records) {
      if (record.summary.status !== 'running') continue;
      record.handle?.stop();
      waits.push(record.ended);
    }
    await Promise.all(waits);
  }

  return {
    async start(projectId, request) {
      const project = await folderOf(projectId);
      const trust = project.terminal ?? DEFAULT_TERMINAL_TRUST;
      if (trust === 'off') throw terminalDisabled();

      let command: string;
      let label: string;
      // The folder exactly as sent: the runner confines it before anything spawns. A script has
      // none: it runs in the project root, always, so its package.json is the one checked here.
      let cwd: string;
      if ('script' in request) {
        const known = await runner.scripts(project.folderPath);
        if (!known.scripts.some((script) => script.name === request.script)) {
          throw notFound(`Script "${request.script}"`);
        }
        if (!SAFE_SCRIPT_NAME.test(request.script)) throw unsafeScriptName(request.script);
        // package.json was read in the meantime: an off that landed then still refuses (D301).
        const latest = await existing(projectId);
        if ((latest.terminal ?? DEFAULT_TERMINAL_TRUST) === 'off') throw terminalDisabled();
        command = `${known.packageManager} run ${request.script}`;
        label = request.label ?? request.script;
        cwd = '';
      } else {
        if (trust === 'scripts') throw terminalRestricted();
        command = request.command;
        label = request.label ?? labelOf(request.command);
        cwd = request.cwd ?? '';
      }

      const records = recordsOf(projectId);
      const running = [...records.values()].filter((r) => r.summary.status === 'running').length;
      if (running >= maxRunning) throw processLimit(maxRunning);

      const summary: ProcessSummary = {
        id: newId(),
        projectId,
        label,
        command,
        cwd: normaliseCwd(cwd),
        status: 'running',
        exitCode: null,
        signal: null,
        startedAt: now(),
      };
      let markEnded: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        markEnded = resolve;
      });
      starts += 1;
      const record: Supervised = {
        summary,
        order: starts,
        output: '',
        truncated: false,
        handle: undefined,
        batcher: createBatcher<Chunk>({ intervalMs: batchMs, flush: flushTo(summary) }),
        ended,
        markEnded,
      };
      records.set(summary.id, record);

      try {
        record.handle = runner.start(
          { root: project.folderPath, cwd, command },
          {
            onOutput(stream, chunk) {
              if (record.summary.status !== 'running') return;
              keep(record, chunk);
              record.batcher.push({ stream, data: chunk });
            },
            onExit: (code, signal) => end(record, 'exited', code, signal),
            onError(error) {
              if (record.summary.status !== 'running') return;
              logger.warn(
                { subsystem: 'processes', projectId, processId: summary.id, reason: error.message },
                'a process could not start',
              );
              // design §10: the tab says why it failed to start.
              const message = `Could not start: ${error.message}\r\n`;
              keep(record, message);
              record.batcher.push({ stream: 'stderr', data: message });
              end(record, 'failed', null, null);
            },
          },
        );
      } catch (error) {
        // A refused working folder: nothing ran, so nothing is remembered.
        records.delete(summary.id);
        throw error;
      }
      return { processId: summary.id };
    },

    async input(projectId, processId, data) {
      const record = find(projectId, processId);
      if (record.summary.status !== 'running') throw processNotRunning(processId);
      record.handle?.write(data);
    },

    async stop(projectId, processId) {
      const record = find(projectId, processId);
      // Idempotent: a finished process is already stopped.
      if (record.summary.status === 'running') record.handle?.stop();
    },

    async list(projectId) {
      await existing(projectId);
      return [...recordsOf(projectId).values()]
        .sort(
          (a, b) =>
            Number(b.summary.status === 'running') - Number(a.summary.status === 'running') ||
            b.order - a.order,
        )
        .map((record) => ({ ...record.summary }));
    },

    async get(projectId, processId) {
      const record = find(projectId, processId);
      return {
        ...record.summary,
        output: tailOf(record.output, outputCap),
        truncated: record.truncated,
      };
    },

    scripts: async (projectId) => runner.scripts((await folderOf(projectId)).folderPath),

    stopProject: (projectId) => stopRunning(byProject.get(projectId)?.values() ?? []),

    stopAll: () => stopRunning([...byProject.values()].flatMap((records) => [...records.values()])),
  };
}
