import type { ActivityItem, NodeError, ToolDefinition } from '@ace/contracts';

import type { ToolResult } from '../ports/index.js';
import {
  resultText,
  withJudgedText,
  type ExecutableTool,
  type ToolProvider,
  type ToolRunContext,
} from '../runs/tool-loop.js';
import { activityItemFor, type ActivityStatus } from './activity.js';

/**
 * The bounded project tool loop of an API-model chat turn (D302, design §4).
 *
 * In a project with a folder, an API model may read and change the project's files from chat, with
 * ACE's own project tools. Only the non-destructive seven are offered — never `run_command` (shell
 * commands belong to CLI nodes, runs with their approval card, and the person's terminal), and
 * never a tool whose definition says it is destructive. Their paths are confined by the tools
 * themselves, exactly as in a run. The loop is the run's, cut down: generate; run each requested
 * tool; feed the results back; and at `maxToolCalls` ask once more with no tools. What the model
 * reads back is the tool's result after the run's context point (`judge`, FR-GRD-004): hidden
 * instructions stripped and personal data redacted per the policy, then the adapter's untrusted
 * labelling (FR-TOOL-010). A result the context point blocks ends the turn. What the turn records
 * is an `ActivityItem` per call, which never holds a result.
 */

/** The project tools a chat turn may offer, in the order they are offered. */
export const CHAT_PROJECT_TOOLS = [
  'list_files',
  'read_file',
  'search',
  'write_file',
  'edit_file',
  'git_status',
  'git_diff',
] as const;

/** The chat project tools the registry has, minus any that is destructive. */
export function chatToolsFrom(tools: ToolProvider | undefined): ExecutableTool[] {
  if (tools === undefined) return [];
  return CHAT_PROJECT_TOOLS.flatMap((name) => {
    const tool = tools.get(name);
    if (tool === undefined || tool.definition.permissions.destructive) return [];
    return [tool];
  });
}

/**
 * The context point over one tool result's text (FR-GRD-004) — the run's `NodeContextHook.toolResult`
 * shape: `continue` with the text the model may read, or `failed` with why it may not.
 */
export type ToolResultJudgement =
  { kind: 'continue'; text: string } | { kind: 'failed'; error: NodeError };

/** A tool the model asked for in one turn. */
export interface ChatToolRequest {
  callId: string;
  name: string;
  args: unknown;
}

export interface ChatToolLoopInput {
  /** The tools on offer; empty, the turn is one plain call. */
  tools: readonly ExecutableTool[];
  /** The most tool calls one turn may make; at it, the model answers without tools. */
  maxToolCalls: number;
  /** `runId` is the chat turn's own id: a chat belongs to no run (FR-CHAT-005). */
  context: ToolRunContext;
  /** One model call: the tools to offer and the results so far in, the tools it asked for out. */
  turn(options: {
    tools?: ToolDefinition[];
    toolResults?: ToolResult[];
  }): Promise<ChatToolRequest[]>;
  /** Each call's activity, pushed as it happens, so a turn that fails later keeps what it did. */
  activity: ActivityItem[];
  /** Told of each call as it ends, for the engine log. */
  onCall?: (name: string, status: ActivityStatus) => void;
  /** The context point every tool result passes before the model reads it. Absent: unchecked. */
  judge?: (text: string) => Promise<ToolResultJudgement>;
  /**
   * PG-2.2: the tool point (FR-GRD-005/006), asked before every offered tool runs. `refuse` stops
   * the call — a guardrail's `block` (`blocked`) or a person's reject of an `ask_user` approval
   * (`refused`) — and the reason is fed back to the model as the call's result, as an unknown
   * tool's refusal is. Absent: every offered tool runs.
   */
  beforeTool?: (tool: ExecutableTool, call: ChatToolRequest) => Promise<ChatToolStep>;
}

/** What the tool point decided for one chat tool call (PG-2.2). */
export type ChatToolStep =
  { kind: 'allow' } | { kind: 'refuse'; status: 'blocked' | 'refused'; reason: string };

export interface ChatToolLoopResult {
  toolCalls: number;
  /** The model still asked for a tool after the limit; its last text is the answer. */
  limitReached: boolean;
  /** The context point blocked a result: the turn ends with this error, the model never reads it. */
  blocked?: NodeError;
}

export async function runChatToolLoop(input: ChatToolLoopInput): Promise<ChatToolLoopResult> {
  const limit = Math.max(0, input.maxToolCalls);
  const offered = limit === 0 ? [] : input.tools;
  const definitions = offered.map((tool) => tool.definition);
  const results: ToolResult[] = [];
  let calls = 0;
  let finalTurn = false;

  for (;;) {
    const offer = !finalTurn && definitions.length > 0;
    const requested = await input.turn({
      ...(offer ? { tools: definitions } : {}),
      ...(results.length > 0 ? { toolResults: [...results] } : {}),
    });
    if (requested.length === 0) return { toolCalls: calls, limitReached: false };
    if (finalTurn || limit === 0) return { toolCalls: calls, limitReached: true };

    for (const call of requested) {
      const tool = offered.find((each) => each.definition.name === call.name);
      let result: unknown;
      let status: ActivityStatus;
      if (tool === undefined) {
        status = 'refused';
        result = {
          error: `${call.name} is not available in chat. The project tools here are: ${
            definitions.map((definition) => definition.name).join(', ') || 'none'
          }.`,
        };
      } else {
        const step: ChatToolStep =
          input.beforeTool === undefined ? { kind: 'allow' } : await input.beforeTool(tool, call);
        if (step.kind === 'refuse') {
          status = step.status;
          result = { error: `${call.name} was not run: ${step.reason}` };
        } else {
          try {
            result = await tool.run(call.args, input.context);
            status = 'ok';
          } catch (error) {
            status = 'error';
            result = { error: error instanceof Error ? error.message : String(error) };
          }
        }
      }

      // What the model reads next passes the context point first, a failure's message included —
      // the run's own rule (`judgeToolResult`). A refusal is the engine's words, not the tool's.
      let blocked: NodeError | undefined;
      if (input.judge !== undefined && status !== 'refused' && status !== 'blocked') {
        const text = resultText(result);
        const judged = await input.judge(text);
        if (judged.kind === 'failed') {
          blocked = judged.error;
          status = 'blocked';
        } else {
          result = withJudgedText(result, text, judged.text);
        }
      }

      input.activity.push(
        activityItemFor({
          tool: call.name,
          args: call.args,
          status,
          ...(input.context.projectDir === undefined
            ? {}
            : { projectDir: input.context.projectDir }),
        }),
      );
      input.onCall?.(call.name, status);
      if (blocked !== undefined) return { toolCalls: calls + 1, limitReached: false, blocked };
      results.push({ callId: call.callId, name: call.name, args: call.args, result });
      calls += 1;
      // At the limit the turn's later calls are not run; the model answers once more, tool-less.
      if (calls >= limit) {
        finalTurn = true;
        break;
      }
    }
  }
}
