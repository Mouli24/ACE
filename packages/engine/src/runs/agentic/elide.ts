import type { AgentTurn, ToolResult } from '../../ports/index.js';

/**
 * Keeping an agentic node's turn history inside its model's context window (D377).
 *
 * Tokens are estimated as characters ÷ 4 over the fixed prompt and every turn. Above 70 % of the
 * window the bodies of the oldest `read_file`, `run_command` and `command_output` results are
 * replaced with {@link ELIDED_OUTPUT}, oldest first, until the estimate is at or below 50 %. The
 * calls, the callIds, each result's record and the provider's opaque turns are never touched, so
 * every call still has its one result (the `AgentTurn` contract) and the model can re-run anything
 * it needs. The gap between the two marks means a history is trimmed in bursts rather than on
 * every turn, which keeps its prefix stable for the provider's cache.
 */

/** What an elided result body reads as. */
export const ELIDED_OUTPUT = '[output elided — re-run if needed]';

/** The tools whose results are the bulky ones, and can be had again by calling them again. */
const ELIDABLE_TOOLS: ReadonlySet<string> = new Set(['read_file', 'run_command', 'command_output']);

/** Above this share of the window the history is trimmed… */
const TRIM_ABOVE = 0.7;
/** …down to this share. */
const TRIM_TO = 0.5;
const CHARS_PER_TOKEN = 4;
/** A field of an object result shorter than this is kept: an exit code, a path, a process id. */
const BODY_MIN_CHARS = 200;

export interface ElisionBudget {
  /** The model's context window, in tokens. */
  contextWindow: number;
  /** The characters every call sends whatever the history: the prompt, the system text, the tools. */
  fixedChars: number;
}

function jsonLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function resultChars(result: ToolResult): number {
  return (
    result.callId.length + result.name.length + jsonLength(result.args) + jsonLength(result.result)
  );
}

/** A turn's size: what the model said (or the provider's own record of it), its calls, its results. */
function turnChars(turn: AgentTurn): number {
  const said =
    turn.opaque !== undefined
      ? jsonLength(turn.opaque.payload)
      : turn.text.length + jsonLength(turn.toolCalls);
  return said + turn.results.reduce((sum, result) => sum + resultChars(result), 0);
}

/**
 * A result with its body elided: a string result becomes {@link ELIDED_OUTPUT}; an object keeps
 * its keys and its short fields, its long text fields elided; anything else long is elided whole.
 * The same value comes back when there is nothing to elide.
 */
function elidedBody(result: unknown): unknown {
  if (typeof result === 'string') return result === ELIDED_OUTPUT ? result : ELIDED_OUTPUT;
  if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
    let changed = false;
    const fields = Object.entries(result as Record<string, unknown>).map(([key, value]) => {
      const long =
        typeof value === 'string'
          ? value.length >= BODY_MIN_CHARS
          : jsonLength(value) >= BODY_MIN_CHARS;
      if (!long || value === ELIDED_OUTPUT) return [key, value] as const;
      changed = true;
      return [key, ELIDED_OUTPUT] as const;
    });
    return changed ? Object.fromEntries(fields) : result;
  }
  return jsonLength(result) >= BODY_MIN_CHARS ? ELIDED_OUTPUT : result;
}

/**
 * The turns to send, trimmed to fit (see the module comment). Under 70 % the same array comes
 * back; otherwise a copy, with the oldest bulky result bodies elided until at or below 50 % — or
 * until nothing more can be elided.
 */
export function elideTurns(turns: AgentTurn[], budget: ElisionBudget): AgentTurn[] {
  const window = Math.max(1, budget.contextWindow);
  let chars = budget.fixedChars + turns.reduce((sum, turn) => sum + turnChars(turn), 0);
  const tokens = (): number => chars / CHARS_PER_TOKEN;
  if (tokens() <= TRIM_ABOVE * window) return turns;

  const out = turns.map((turn) => ({ ...turn, results: [...turn.results] }));
  for (const turn of out) {
    for (let index = 0; index < turn.results.length; index += 1) {
      if (tokens() <= TRIM_TO * window) return out;
      const result = turn.results[index]!;
      if (!ELIDABLE_TOOLS.has(result.name)) continue;
      const body = elidedBody(result.result);
      if (body === result.result) continue;
      const elided: ToolResult = { ...result, result: body };
      chars -= resultChars(result) - resultChars(elided);
      turn.results[index] = elided;
    }
  }
  return out;
}
