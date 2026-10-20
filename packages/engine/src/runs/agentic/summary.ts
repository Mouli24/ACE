import {
  TOOL_CALL_CHANGED_PATHS_MAX,
  type ActivityItem,
  type Checkpoint,
  type ToolCall,
  type WorkspaceSummary,
} from '@ace/contracts';

import { activityItemFor, projectPath, type ActivityStatus } from '../../chat/activity.js';
import { CANCELLED_SUMMARY } from './index.js';

/**
 * What an agentic node's step did in the project folder (D378): the files it changed and the
 * commands it ran, handed to the next node in its envelope's `workspace` block and kept on its node
 * run. Facts only — paths, line counts, command lines and exit codes — never a file's contents or
 * a command's output, and never the turn history (BR-02).
 */

/** The most files and commands one summary lists (`WorkspaceSummarySchema`). */
const FILES_MAX = 500;
const COMMANDS_MAX = 200;
const COMMAND_TEXT_MAX = 2_000;

/** The tools whose `path` argument is a file they write. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A project path as the summary writes it: project-relative, forward slashes, no `./`. */
function normalPath(path: string, projectDir: string | undefined): string {
  return projectPath(path.trim(), projectDir).replace(/^\.\/+/, '');
}

/**
 * The files one successful call of an agentic node changed (D378): a write tool's `path`, or the
 * `changedPaths` a `run_command` detected. `undefined` for every other call, and when it names none.
 */
export function changedPathsOf(
  toolName: string,
  args: unknown,
  result: unknown,
  projectDir: string | undefined,
): string[] | undefined {
  let raw: unknown[] = [];
  if (WRITE_TOOLS.has(toolName)) {
    raw = [record(args)?.['path']];
  } else if (toolName === 'run_command') {
    const listed = record(result)?.['changedPaths'];
    raw = Array.isArray(listed) ? listed : [];
  }
  const paths = [
    ...new Set(
      raw
        .filter((path): path is string => typeof path === 'string' && path.trim() !== '')
        .map((path) => normalPath(path, projectDir))
        .filter((path) => path !== '' && path !== '.'),
    ),
  ].slice(0, TOOL_CALL_CHANGED_PATHS_MAX);
  return paths.length === 0 ? undefined : paths;
}

/** A call a Stop caught before it ran: logged `error` with the summary `cancelled` (D375). */
function wasCancelled(call: ToolCall): boolean {
  return (
    call.status === 'error' && call.resultSummary === CANCELLED_SUMMARY && call.durationMs === 0
  );
}

/**
 * A `run_command`'s exit code, from its logged summary — the result's JSON, whose first field is
 * `exitCode` (`@ace/tools`' run-command). `null` when the summary does not say: a timeout, a
 * command that could not start, a background one.
 */
function exitCodeOf(call: ToolCall): number | null {
  const match = /^\{"exitCode":(-?\d+)/.exec(call.resultSummary);
  return match === null ? null : Number(match[1]);
}

/**
 * One step's summary (D378). Files come from the step checkpoint when it was recorded — its
 * files' additions and deletions, without the ones the person changed through Forge meanwhile —
 * and otherwise from the union of the calls' `changedPaths`, at 0/0. `recorded` says a recording
 * finished: with no checkpoint, that means nothing changed. Commands are the `run_command` calls
 * that ran — not the blocked, denied or cancelled ones — in order.
 */
export function summarizeStep(input: {
  toolCalls: readonly ToolCall[];
  checkpoint?: Checkpoint;
  /** The step's checkpoint recording finished (`checkpoint` absent: it changed nothing). */
  recorded?: boolean;
}): WorkspaceSummary {
  const checkpoint = input.checkpoint?.status === 'failed' ? undefined : input.checkpoint;

  let filesChanged: WorkspaceSummary['filesChanged'];
  if (checkpoint !== undefined) {
    filesChanged = checkpoint.files
      .filter((file) => file.state !== 'person')
      .map((file) => ({ path: file.path, added: file.additions, removed: file.deletions }));
  } else if (input.recorded === true && input.checkpoint === undefined) {
    filesChanged = [];
  } else {
    const paths = new Set(input.toolCalls.flatMap((call) => call.changedPaths ?? []));
    filesChanged = [...paths].map((path) => ({ path, added: 0, removed: 0 }));
  }

  const commands = input.toolCalls
    .filter(
      (call) =>
        call.toolName === 'run_command' &&
        (call.status === 'ok' || call.status === 'error' || call.status === 'timeout') &&
        !wasCancelled(call),
    )
    .flatMap((call) => {
      const command = record(call.args)?.['command'];
      if (typeof command !== 'string' || command.trim() === '') return [];
      return [
        {
          command:
            command.length <= COMMAND_TEXT_MAX ? command : command.slice(0, COMMAND_TEXT_MAX),
          exitCode: call.status === 'ok' ? exitCodeOf(call) : null,
          durationMs: call.durationMs,
        },
      ];
    });

  return {
    ...(checkpoint === undefined ? {} : { checkpointId: checkpoint.id }),
    filesChanged: filesChanged.slice(0, FILES_MAX),
    commands: commands.slice(0, COMMANDS_MAX),
  };
}

/** How a logged call reads in the chat's "What it did" (D302): the person denied, a Stop cancelled. */
function activityStatusOf(call: ToolCall): ActivityStatus {
  if (wasCancelled(call)) return 'cancelled';
  switch (call.status) {
    case 'ok':
      return 'ok';
    case 'blocked':
      return 'blocked';
    case 'rejected':
      return 'denied';
    default:
      return 'error';
  }
}

/**
 * An agentic node run's tool calls as the chat's activity (D378, D302): what it read, wrote, edited
 * and ran, from each call's name and arguments only — never what came back (design §7).
 */
export function stepActivity(
  toolCalls: readonly ToolCall[],
  projectDir: string | undefined,
): ActivityItem[] {
  return toolCalls.map((call) =>
    activityItemFor({
      tool: call.toolName,
      args: call.args,
      status: activityStatusOf(call),
      ...(projectDir === undefined ? {} : { projectDir }),
    }),
  );
}
