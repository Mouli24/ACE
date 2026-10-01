/**
 * What a guardrail check answers, and what it is allowed to say (round 3 §4 item 3, FR-GRD-011,
 * FR-GRD-014, Arch §13.3).
 *
 * Every check in this package is a **pure function**: no clock, no randomness, no I/O, no state.
 * The engine decides what to *do* with the answer — pass, warn, redact, ask_user or block comes
 * from `check.action`, never from the check itself (FR-GRD-011).
 */

import type {
  EnvelopeContract,
  GuardrailCheck,
  HiddenInstructionType,
  Part,
  ToolDefinition,
} from '@ace/contracts';

/**
 * One check's answer.
 *
 * `redactedTypes` names what was found — `email`, `anthropic_api_key`, `violence` — and never the
 * value, which is FR-GRD-014 and the hard rule of this package. `reason` is written the same way:
 * it counts and names, it never quotes. `sanitized` is the text that may flow on when the action is
 * `redact`: every offending span replaced by `[<type> redacted]`.
 */
export interface CheckResult {
  passed: boolean;
  reason: string;
  redactedTypes?: string[];
  /**
   * Context point only (round 5 §2.3): the kinds of hidden instruction `prompt_injection` stripped,
   * each once, in first-found order. Names the kind, never the stripped text.
   */
  strippedTypes?: HiddenInstructionType[];
  sanitized?: string;
}

/**
 * Everything a check might need, in one bag.
 *
 * The engine builds one of these per guardrail point and hands the same object to every check at
 * that point; each check reads only the field it genuinely needs and `evaluateCheck` answers
 * `undefined` when the field it needs is absent — a cost check handed nothing but text has nothing
 * to say, and silence is not a pass.
 */
export interface GuardrailInput {
  /** The text under inspection: the Input node's content, an envelope's reads, or an output. */
  text?: string;
  /** A node's output parts — what the `contract` check validates. */
  parts?: readonly Part[];
  /** The contract the envelope carried, for the `contract` check. */
  contract?: EnvelopeContract;
  /** The measured number a threshold check compares: tokens, dollars, iterations, tool calls. */
  value?: number;
  /**
   * The cap to use when the policy's own `params` name none — the project's `maxCostPerRunUsd`,
   * the settings' `dailyBudgetUsd`, or the agent's `execution.maxTokens` (round 3 §2.3).
   */
  limit?: number;
  /** A node's recent output hashes in arrival order, oldest first — for `repeated_output`. */
  outputHashes?: readonly string[];
  /**
   * Everything the tool point needs about the call in flight, present only when the engine is at
   * the `tool` point (round 4 §2.2, FR-GRD-005/006). The four tool checks read it and every other
   * check ignores it; a check that needs it and is handed none answers `undefined` — silence, the
   * same rule the cost and contract checks follow.
   */
  tool?: ToolGuardrailInput;
}

/**
 * The tool call a tool-point check judges (round 4 §2.2, FR-GRD-005/006, Arch §13.1).
 *
 * The engine builds one of these when a `tool_call` chunk arrives and hands it, inside a
 * `GuardrailInput`, to every enabled tool-point check of the resolved policy — then applies each
 * `check.action` (`block` → `blocked` ToolCall + node `GUARDRAIL_VIOLATION`, FR-GRD-012;
 * `ask_user` → the Round 3 approval flow, FR-GRD-006). Nothing here is text the value rule
 * (FR-GRD-014) would quote: `args` never reaches a `reason`.
 */
export interface ToolGuardrailInput {
  /** The tool being called — its `inputSchema` and `permissions` decide most of the verdicts. */
  definition: ToolDefinition;
  /** The arguments the model asked to call it with (`ToolCall.args`, still open/unredacted). */
  args: unknown;
  /** The tool names the agent has switched on (`AgentConfig.tools.enabled`) — for `tool_allowed`. */
  enabledTools: readonly string[];
  /**
   * The run's sandbox folder, `<projectFolder>/.ace/sandbox/<runId>/` (round 4 §2.2). Every path
   * argument must resolve inside it, and `path_confinement` is what enforces that (FR-GRD-006).
   */
  sandboxDir: string;
  /**
   * The hosts the agent permits (`AgentConfig.tools.allowedDomains`). An **empty list allows
   * nothing** (round 4 §2.2), so `domain_allowlist` blocks every URL until a host is added.
   */
  allowedDomains: readonly string[];
}

/** A check implementation: pure, and free to say nothing about an input it cannot judge. */
export type CheckFn = (check: GuardrailCheck, input: GuardrailInput) => CheckResult | undefined;

/** How a redacted span is written back into the text (FR-GRD-014, Arch §13.3). */
export function redactionMarker(type: string): string {
  return '[' + type + ' redacted]';
}
