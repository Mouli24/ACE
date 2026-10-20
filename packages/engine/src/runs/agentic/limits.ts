import type { AgentWorkspace, NodeError } from '@ace/contracts';

/**
 * An agentic node's own limits (D375, FR-TOOL-003): its Max turns and its token budget. Checked
 * before every model call of its tool loop, so a node that reached either makes no further call.
 * The policy's `max_tool_calls` is a separate cap, applied by the loop with round 4's rule.
 */

/** What the loop has spent so far in this node step, every model turn and every attempt counted. */
export interface AgentLimitState {
  /** Model turns made. */
  turns: number;
  tokensIn: number;
  tokensOut: number;
}

/**
 * The error codes a limit stops an agentic node with — its own two, and the policy's tool-call
 * cap. Never repaired or retried: a retry would run the whole loop again, every edit and command,
 * to reach the same limit.
 */
export const AGENT_LIMIT_CODES: readonly string[] = [
  'max_turns',
  'token_budget',
  'tool_call_limit',
];

/**
 * `agent/max_turns` once the node has made its Max turns, `agent/token_budget` once its tokens in
 * and out reach its budget; `undefined` while it may make another call. A node without a budget
 * has only its Max turns.
 */
export function checkLimits(state: AgentLimitState, ws: AgentWorkspace): NodeError | undefined {
  if (state.turns >= ws.maxTurns) {
    return {
      kind: 'agent',
      code: 'max_turns',
      message: `Stopped after ${state.turns} turns, this node's Max turns. Raise it in the node's settings.`,
      retryable: false,
    };
  }
  const used = state.tokensIn + state.tokensOut;
  if (ws.tokenBudget !== undefined && used >= ws.tokenBudget) {
    return {
      kind: 'agent',
      code: 'token_budget',
      message: `Stopped at ${used} tokens, this node's token budget.`,
      retryable: false,
    };
  }
  return undefined;
}

/** Whether a node error is one of the limits above, which the scheduler must not retry. */
export function isAgentLimitError(error: Pick<NodeError, 'kind' | 'code'>): boolean {
  return error.kind === 'agent' && AGENT_LIMIT_CODES.includes(error.code);
}
