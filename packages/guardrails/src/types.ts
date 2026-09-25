/**
 * What a guardrail check answers, and what it is allowed to say (round 3 §4 item 3, FR-GRD-011,
 * FR-GRD-014, Arch §13.3).
 *
 * Every check in this package is a **pure function**: no clock, no randomness, no I/O, no state.
 * The engine decides what to *do* with the answer — pass, warn, redact, ask_user or block comes
 * from `check.action`, never from the check itself (FR-GRD-011).
 */

import type { EnvelopeContract, GuardrailCheck, Part } from '@ace/contracts';

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
}

/** A check implementation: pure, and free to say nothing about an input it cannot judge. */
export type CheckFn = (check: GuardrailCheck, input: GuardrailInput) => CheckResult | undefined;

/** How a redacted span is written back into the text (FR-GRD-014, Arch §13.3). */
export function redactionMarker(type: string): string {
  return '[' + type + ' redacted]';
}
