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
  agentCommandReadOnly,
  agentCommandStopRun,
  processLimit,
  engineStopping,
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
  /**
   * Releases a deleted project's records. Call it only after `stopProject` resolved:
   * the kept output of up to 20 finished processes would otherwise stay until the engine restarts.
   */
  forgetProject(projectId: Id): void;
  /** Shutdown (FR-SYS-008): stops every running process; resolves when each has ended. */
  stopAll(): Promise<void>;
  /**
   * PG-5.3 (D361): an agentic node's `run_command` (foreground or background) as a read-only row
   * of the project's processes, tagged with its run and node: its output goes out as
   * `process.output` frames and its end as `process.exited`, exactly as a person's command's do.
   * It counts toward no limit and no trust level (the run's approvals govern it, D342), takes no
   * input, and is stopped by its run, never from Forge. The feed's calls after the end are ignored.
   */
  observeAgentCommand(projectId: Id, spec: AgentCommandSpec): AgentCommandFeed;
}

/** PG-5.3: what an agent's command is, as the processes list shows it. */
export interface AgentCommandSpec {
  runId: Id;
  nodeId: Id;
  command: string;
  /** Project-relative, as the list shows it (`''` for the root). */
  cwd: string;
  /** `run_command` with `background: true` (Task 14): such a row can be killed from Forge. */
  background: boolean;
  /** The background command's id in the run's agent session; never sent over the wire. */
  sessionProcessId?: string;
}

/** PG-5.3: an agent's command reporting in as it runs. */
export interface AgentCommandFeed {
  output(stream: ProcessStream, data: string): void;
  /** `failed`: the shell never started. */
  exited(exitCode: number | null, failed: boolean): void;
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
  /**
   * PG-5.2 (D361): a person's own command started (`true`) or ended (`false`), so the checkpoints
   * can book what it changes as the person's. Never told about an agent's command. A throw here
   * is logged and changes nothing about the process.
   */
  onPersonCommand?: (projectId: Id, processId: Id, running: boolean) => void;
  /**
   * Task 14: kills a run's background agent command by its id in the run's agent session (the
   * session lives in the server, which owns `@ace/tools`). Absent, Stop on any agent row refuses.
   */
  killAgentCommand?: (runId: Id, sessionProcessId: string) => Promise<boolean>;
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
  /** Task 14: a background agent command's id in its run's agent session. */
  sessionProcessId?: string;
  /** Start order: "newest first" even when two start in the same millisecond. */
  order: number;
  /** Set when it ends; the recent list drops the lowest first. */
  finishOrder: number;
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
  let finishes = 0;
  /** Set by `stopAll`: nothing starts again, because the engine is going away (FR-SYS-008). */
  let closed = false;
  /**
   * Per project, bumped first by `stopProject`. A start captures it on entry and checks it again
   * just before it spawns, so a start that was waiting on package.json while its project was
   * switched off or deleted does not spawn after the stop.
   */
  const epochs = new Map<Id, number>();
  const epochOf = (projectId: Id): number => epochs.get(projectId) ?? 0;

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

  /** PG-5.2: the checkpoints hear when a person's own command starts and ends. */
  function personCommand(summary: ProcessSummary, running: boolean): void {
    if (summary.agent !== undefined || deps.onPersonCommand === undefined) return;
    try {
      deps.onPersonCommand(summary.projectId, summary.id, running);
    } catch (error) {
      logger.warn(
        {
          subsystem: 'processes',
          processId: summary.id,
          reason: error instanceof Error ? error.message : String(error),
        },
        'could not tell the checkpoints about a terminal command',
      );
    }
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

      .sort((a, b) => a.finishOrder - b.finishOrder);
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
    finishes += 1;
    record.finishOrder = finishes;
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
    personCommand(record.summary, false);
    record.markEnded();
    prune(record.summary.projectId);
  }

  async function stopRunning(records: Iterable<Supervised>): Promise<void> {
    const waits: Array<Promise<void>> = [];
    for (const record of records) {
      if (record.summary.status !== 'running') continue;
      // An agent's command is its run's to stop (PG-5.3): it holds no handle here.
      if (record.summary.agent !== undefined) continue;
      record.handle?.stop();
      waits.push(record.ended);
    }
    await Promise.all(waits);
  }

  return {
    async start(projectId, request) {
      const epoch = epochOf(projectId);
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

      // The last synchronous section before the spawn: nothing awaits from here to `runner.start`.
      if (closed) throw engineStopping();
      // A stop of this project landed meanwhile (the terminal went off, or the project was
      // deleted). A racing start on a deleted project reads "the terminal is off" rather than 404;
      // that is acceptable.
      if (epochOf(projectId) !== epoch) throw terminalDisabled();

      const records = recordsOf(projectId);
      const running = [...records.values()].filter(
        (r) => r.summary.status === 'running' && r.summary.agent === undefined,
      ).length;
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
        finishOrder: 0,
        output: '',
        truncated: false,
        handle: undefined,
        batcher: createBatcher<Chunk>({ intervalMs: batchMs, flush: flushTo(summary) }),
        ended,
        markEnded,
      };
      records.set(summary.id, record);
      personCommand(summary, true);

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
        personCommand(summary, false);
        throw error;
      }
      return { processId: summary.id };
    },

    async input(projectId, processId, data) {
      const record = find(projectId, processId);
      if (record.summary.agent !== undefined) throw agentCommandReadOnly(processId);
      if (record.summary.status !== 'running') throw processNotRunning(processId);
      record.handle?.write(data);
    },

    async stop(projectId, processId) {
      const record = find(projectId, processId);
      const agent = record.summary.agent;
      if (agent !== undefined && record.summary.status === 'running') {
        // Task 14: a background command can be killed from Forge; a foreground one is its run's.
        if (
          !agent.background ||
          record.sessionProcessId === undefined ||
          deps.killAgentCommand === undefined
        ) {
          throw agentCommandStopRun(processId);
        }
        await deps.killAgentCommand(agent.runId, record.sessionProcessId);
        return;
      }
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

    stopProject(projectId) {
      epochs.set(projectId, epochOf(projectId) + 1);
      return stopRunning(byProject.get(projectId)?.values() ?? []);
    },

    forgetProject(projectId) {
      byProject.delete(projectId);
      // The epoch stays (one number): dropping it would let a start still in flight match again.
    },

    stopAll() {
      closed = true;
      return stopRunning([...byProject.values()].flatMap((records) => [...records.values()]));
    },

    observeAgentCommand(projectId, spec) {
      const summary: ProcessSummary = {
        id: newId(),
        projectId,
        label: labelOf(spec.command),
        command: spec.command,
        cwd: normaliseCwd(spec.cwd),
        status: 'running',
        exitCode: null,
        signal: null,
        startedAt: now(),
        agent: { runId: spec.runId, nodeId: spec.nodeId, background: spec.background },
      };
      let markEnded: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        markEnded = resolve;
      });
      starts += 1;
      const record: Supervised = {
        summary,
        order: starts,
        finishOrder: 0,
        output: '',
        truncated: false,
        handle: undefined,
        ...(spec.sessionProcessId === undefined ? {} : { sessionProcessId: spec.sessionProcessId }),
        batcher: createBatcher<Chunk>({ intervalMs: batchMs, flush: flushTo(summary) }),
        ended,
        markEnded,
      };
      recordsOf(projectId).set(summary.id, record);
      return {
        output(stream, data) {
          if (record.summary.status !== 'running' || data === '') return;
          keep(record, data);
          record.batcher.push({ stream, data });
        },
        exited(exitCode, failed) {
          end(record, failed ? 'failed' : 'exited', exitCode, null);
        },
      };
    },
  };
}
