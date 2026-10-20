import { TOOL_TARGET_MAX, type AgentWorkspace } from '@ace/contracts';

import { maskSecrets } from '../../security/secret-patterns.js';
import type { AgentTurn } from '../../ports/index.js';

/**
 * Agentic nodes (D375, D377, D378, D381): the engine half of a node that works in the project
 * folder like a coding agent. The executor branches into this module and keeps today's path,
 * line for line, for every node whose workspace access is Off.
 */

// `commands.ts` (D376) is imported where it is used: it reaches the graph service.
export * from './elide.js';
export * from './limits.js';
export * from './system-prompt.js';

/** A model's window when its catalog row is missing (it is refused before a run otherwise). */
export const AGENT_DEFAULT_CONTEXT_WINDOW = 128_000;

/** What the model reads when the person denied its command (D376). */
export const DENIED_COMMAND_ERROR = 'The person denied this command.';

/** The summary of a call a Stop caught before it ran (D375). */
export const CANCELLED_SUMMARY = 'cancelled';

/**
 * The result a denied `run_command` hands back to the model (D376): not a failure of the node — the
 * model reads that the person said no, and why when they said, and goes on.
 */
export function deniedCommandResult(note?: string): {
  denied: true;
  error: string;
  note?: string;
} {
  const said = note?.trim();
  return {
    denied: true,
    error: DENIED_COMMAND_ERROR,
    ...(said === undefined || said === '' ? {} : { note: said }),
  };
}

/**
 * The result of a call the policy's `max_tool_calls` left unrun (round 4 §2.2): every call in a
 * turn has one result (the `AgentTurn` contract), so the ones after the limit say why they did not
 * run.
 */
export function skippedCallResult(limit: number): { skipped: true; error: string } {
  return {
    skipped: true,
    error: `Not run: this node reached its limit of ${limit} tool calls. Finish without tools.`,
  };
}

/**
 * The history without the providers' opaque records (D377): on a fallback to another model those
 * records belong to the model that wrote them, and another model must never be sent its thought
 * signatures. The neutral fields carry the turn instead.
 */
export function withoutOpaque(turns: readonly AgentTurn[]): AgentTurn[] {
  return turns.map(({ opaque: _opaque, ...turn }) => turn);
}

const stringField = (args: unknown, key: string): string | undefined => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/**
 * The background process a `run_command { background: true }` started, from its result
 * (`{ processId, background: true }`), so a later `command_output` can name its command.
 */
export function backgroundProcessOf(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const bag = result as Record<string, unknown>;
  return bag['background'] === true && typeof bag['processId'] === 'string'
    ? bag['processId']
    : undefined;
}

/**
 * What `tool.started` names (D381): the command a `run_command` runs, the command behind a
 * `command_output`/`kill_command` process id when this node started it, otherwise the path a tool
 * works on. One line, secret-masked, at most {@link TOOL_TARGET_MAX} characters; `undefined` when
 * the call names nothing.
 */
export function toolTarget(
  name: string,
  args: unknown,
  backgroundCommands: ReadonlyMap<string, string>,
): string | undefined {
  let raw: string | undefined;
  if (name === 'run_command') {
    raw = stringField(args, 'command');
  } else if (name === 'command_output' || name === 'kill_command') {
    const processId = stringField(args, 'processId');
    raw = processId === undefined ? undefined : (backgroundCommands.get(processId) ?? processId);
  } else {
    raw = stringField(args, 'path') ?? stringField(args, 'file_path');
  }
  if (raw === undefined) return undefined;
  const line = maskSecrets(raw.replace(/\s+/g, ' ').trim());
  if (line === '') return undefined;
  return line.length <= TOOL_TARGET_MAX ? line : `${line.slice(0, TOOL_TARGET_MAX - 1)}…`;
}

/** The limits an agentic node's loop runs under, and what it has spent across its attempts. */
export interface AgentLoopState {
  workspace: AgentWorkspace;
  /** The turns so far, oldest first — kept elided, so a trim happens in bursts (D377). */
  history: AgentTurn[];
  turns: number;
  tokensIn: number;
  tokensOut: number;
  /** Tool calls run, counted against the policy's `max_tool_calls`. */
  toolCalls: number;
  /** The model the history's opaque records came from; a fallback to another drops them. */
  modelKey?: string;
  /** processId → command, for the background commands this node started. */
  backgroundCommands: Map<string, string>;
}

export function newAgentLoopState(workspace: AgentWorkspace): AgentLoopState {
  return {
    workspace,
    history: [],
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    toolCalls: 0,
    backgroundCommands: new Map(),
  };
}
