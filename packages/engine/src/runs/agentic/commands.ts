import {
  ALLOWED_COMMANDS_MAX,
  AllowedCommandSchema,
  agentWorkspaceOf,
  isAgentic,
  type Id,
  type Node,
} from '@ace/contracts';

import { HttpError } from '../../gateway/errors.js';
import type { GraphService } from '../../graph/index.js';
import type { Logger } from '../../logging/index.js';

/**
 * Command approvals for agentic nodes (D376, FR-GRD-006, D342/D348).
 *
 * Every `run_command` of an agentic node asks unless the node's allowed commands cover it. The
 * judgement is `@ace/tools`' `classifyCommand`, which splits a line into segments and holds each to
 * the denylist and the allowlist; the engine may not import that package (CLAUDE.md §3.4 rule 3),
 * so it arrives here as an injected `CommandClassifier` and the gateway wires the real one.
 *
 * A run keeps its own `RunAllowlist`, seeded from the snapshot and grown by Always allow, so the next
 * identical command in the same run runs without a card. The snapshot itself is never written
 * (BR-04, D345): Always allow saves the prefix on the *saved* workflow's node instead, through the
 * graph service's normal node update, so the next run starts with it.
 */

/** What the engine reads of `@ace/tools`' `Classification`. */
export interface CommandClassification {
  /** Read confidently, nothing denied, every segment covered by the allowlist. */
  autoAllowed: boolean;
  /** One prefix that covers the whole line, offered only when nothing was denied. */
  alwaysAllowPrefix?: string;
  /** Ids of the denylist rules the line hit. */
  denied: readonly string[];
}

/** `classifyCommand(command, allowlist)` from `@ace/tools`, injected (CLAUDE.md §3.4 rule 3). */
export type CommandClassifier = (
  command: string,
  allowlist: readonly string[],
) => CommandClassification;

/** Run it without asking, or ask — offering Always allow only when `allowPrefix` is set. */
export type CommandGate =
  { kind: 'allow' } | { kind: 'ask'; allowPrefix?: string; denylisted: boolean };

/** What a command gets when nothing can vouch for it: a card, with no Always allow on it. */
const ask = (): CommandGate => ({ kind: 'ask', denylisted: false });

/**
 * The gate for one command line against one node's allowlist (D342/D348). It fails closed: a
 * classifier that throws asks, a denylist hit always asks and never offers a prefix, whatever else
 * the classification says, and a prefix that could not be saved as an allowed command is not
 * offered.
 */
export function commandGate(
  command: string,
  allowlist: readonly string[],
  classify: CommandClassifier,
): CommandGate {
  let classification: CommandClassification;
  try {
    classification = classify(command, allowlist);
  } catch {
    return ask();
  }
  const denylisted = classification.denied.length > 0;
  if (classification.autoAllowed && !denylisted) return { kind: 'allow' };

  const prefix = denylisted ? undefined : classification.alwaysAllowPrefix;
  const offered = prefix !== undefined && AllowedCommandSchema.safeParse(prefix).success;
  return { kind: 'ask', ...(offered ? { allowPrefix: prefix } : {}), denylisted };
}

/** The allowed commands of each node in one run: the snapshot's, plus what Always allow added. */
export interface RunAllowlist {
  for(nodeId: Id): readonly string[];
  add(nodeId: Id, prefix: string): void;
}

/** Seeded from each Agent node's `workspace.allowedCommands`; the snapshot is copied, never kept. */
export function createRunAllowlist(snapshotNodes: readonly Node[]): RunAllowlist {
  const lists = new Map<Id, string[]>();
  for (const node of snapshotNodes) {
    if (node.kind !== 'agent') continue;
    lists.set(node.id, [...agentWorkspaceOf(node.config).allowedCommands]);
  }

  return {
    for: (nodeId) => [...(lists.get(nodeId) ?? [])],
    add(nodeId, prefix) {
      const list = lists.get(nodeId) ?? [];
      if (!list.includes(prefix)) list.push(prefix);
      lists.set(nodeId, list);
    },
  };
}

/** The tool bag's `command` field: the line and its gate, for `beforeTool`. */
export interface ToolCommand {
  text: string;
  gate: CommandGate;
}

/**
 * The `command` for one tool call, or `undefined` for anything that is not an agentic Agent node's
 * `run_command` with a string `command` — those keep today's approval exactly. Read at call time,
 * so a prefix Always allow added a moment ago already counts. Without a classifier it asks and
 * offers nothing. Only `edit_commands` may run a command unasked: a node set below it since its
 * allowed commands were saved asks every time and is offered no Always allow.
 */
export function toolCommandFor(input: {
  node: Node;
  toolName: string;
  args: unknown;
  allowlist: RunAllowlist;
  classify?: CommandClassifier;
}): ToolCommand | undefined {
  const { node, toolName, args } = input;
  if (toolName !== 'run_command' || node.kind !== 'agent' || !isAgentic(node.config)) {
    return undefined;
  }
  const text =
    typeof args === 'object' && args !== null ? (args as { command?: unknown }).command : undefined;
  if (typeof text !== 'string') return undefined;

  const gated =
    input.classify === undefined
      ? ask()
      : commandGate(text, input.allowlist.for(node.id), input.classify);
  const gate: CommandGate =
    agentWorkspaceOf(node.config).access === 'edit_commands'
      ? gated
      : { kind: 'ask', denylisted: gated.kind === 'ask' && gated.denylisted };
  return { text, gate };
}

/** The two graph-service calls saving a prefix needs. */
export type AllowedCommandGraph = Pick<GraphService, 'getWorkflowGraph' | 'applyGraphOps'>;

/** What saving did: wrote it, found it there already, found no Agent node, or found the list full. */
export type SaveAllowedOutcome = 'saved' | 'unchanged' | 'missing' | 'full';

/** A save that lost a race with another edit reads the graph again, this many times in all. */
const SAVE_ATTEMPTS = 3;

/**
 * Always allow on the saved workflow (D376): the node's `workspace.allowedCommands` gains the prefix
 * through an `update_node` graph op — the path the node settings take — so the version moves on and
 * `workflow.updated` reaches the canvas. A node turned Off since keeps the prefix for when it is
 * turned back on. A save that met a newer version is retried on a fresh read.
 */
export async function saveAllowedCommand(
  graph: AllowedCommandGraph,
  workflowId: Id,
  nodeId: Id,
  prefix: string,
): Promise<SaveAllowedOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    const { workflow, nodes } = await graph.getWorkflowGraph(workflowId);
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (node?.kind !== 'agent') return 'missing';

    const workspace = agentWorkspaceOf(node.config);
    if (workspace.allowedCommands.includes(prefix)) return 'unchanged';
    if (workspace.allowedCommands.length >= ALLOWED_COMMANDS_MAX) return 'full';

    try {
      await graph.applyGraphOps(workflowId, {
        baseVersion: workflow.version,
        ops: [
          {
            op: 'update_node',
            nodeId,
            patch: {
              config: {
                workspace: {
                  ...workspace,
                  allowedCommands: [...workspace.allowedCommands, prefix],
                },
              },
            },
          },
        ],
      });
      return 'saved';
    } catch (error) {
      const stale = error instanceof HttpError && error.code === 'stale_version';
      if (!stale || attempt >= SAVE_ATTEMPTS) throw error;
    }
  }
}

export interface AlwaysAllowDeps {
  /** The live run's allowlist: `RunService.allowlistFor`. Absent once the run has ended. */
  allowlistFor(runId: Id): RunAllowlist | undefined;
  /** The workflow a run belongs to. */
  workflowOf(runId: Id): Promise<Id | undefined>;
  graph: AllowedCommandGraph;
  logger: Logger;
}

/**
 * The approval service's `onAlways` (D376): the live run first — synchronously, so the node the
 * decision wakes already runs the next identical command without a card — then the saved node. The
 * decision is already recorded, so a failed save is logged rather than thrown back at the person.
 */
export function createAlwaysAllow(
  deps: AlwaysAllowDeps,
): (runId: Id, nodeId: Id, prefix: string) => Promise<void> {
  return async (runId, nodeId, prefix) => {
    deps.allowlistFor(runId)?.add(nodeId, prefix);
    try {
      const workflowId = await deps.workflowOf(runId);
      if (workflowId === undefined) return;
      const outcome = await saveAllowedCommand(deps.graph, workflowId, nodeId, prefix);
      if (outcome === 'missing' || outcome === 'full') {
        deps.logger.warn(
          { subsystem: 'approvals', runId, nodeId, outcome },
          'always-allowed command not saved on the node',
        );
      }
    } catch (error) {
      deps.logger.warn(
        { subsystem: 'approvals', runId, nodeId, err: error },
        'always-allowed command not saved on the node',
      );
    }
  };
}
