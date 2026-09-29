import type { EnvelopeContract, GuardrailCheck, GuardrailPoint, Part } from '@ace/contracts';

import type { ToolPointInput } from '../runs/tool-loop.js';

/**
 * The seam between the guardrail *engine* and the guardrail *checks* (Arch §13.2).
 *
 * The checks themselves are pure and live in `@ace/guardrails` — regex rule packs, key-format
 * patterns, word lists. The engine may not import that package's internals (CLAUDE.md §3.4 rule 3
 * puts adapters behind ports), and it must not know how a check decides anything: it knows only
 * that a check answered, what it found, and which action the policy configured. Everything below
 * is therefore an interface, and `@ace/guardrails` supplies the implementation at wiring time.
 *
 * Two interfaces, because they answer to different rules:
 *
 * - `CheckRunner` runs a *policy* check. A policy decides whether it runs and what happens when it
 *   triggers, so its result is advice the engine acts on.
 * - `SecretMasker` is the *data* guardrail. No policy configures it, nothing can switch it off
 *   (BR-15, FR-GRD-010), and the engine applies it unconditionally to every output before that
 *   output flows on or is stored (D86).
 */

/** What a check is given to look at. Only the fields its type needs are ever populated. */
export interface CheckInput {
  /** The point being evaluated. A `pii` check is filed at both `input` and `output` (§2.2). */
  point: GuardrailPoint;
  /**
   * The text under inspection: the concatenated text of the parts at `input`, the generated text
   * at `output`. A check that redacts returns its replacement in `sanitized`.
   */
  text: string;
  /** The parts themselves, for a check that reads structure — `required_citations` wants a `sources` array. */
  parts?: readonly Part[];
  /** The output contract, for the `contract` check (FR-EXE-006). */
  contract?: EnvelopeContract;
  /** The loop counters, for `max_iterations`, `max_tool_calls` and `repeated_output` (§2.4). */
  loop?: LoopCheckInput;
  /** The cost figures, for `max_cost_per_run`, `daily_budget` and `max_tokens_per_node` (§2.3). */
  cost?: CostCheckInput;
  /**
   * The tool call in flight, for the four tool-point checks — `tool_allowed`, `path_confinement`,
   * `domain_allowlist`, `destructive_action` (round 4 §2.2, FR-GRD-005/006). It is the
   * `ToolGuardrailInput` shape of `@ace/guardrails`; the server's CheckRunner adapter maps it onto
   * `GuardrailInput.tool` so the pure checks read it, exactly as the loop and cost fields are mapped.
   */
  tool?: ToolPointInput;
}

export interface LoopCheckInput {
  /** The iteration that has just finished; 1 for a node's first pass. */
  iteration: number;
  /** How many tool calls this node has made in this iteration (enforced by the tool loop in round 4). */
  toolCalls: number;
  /**
   * A hash per completed iteration of this node, oldest first, so `repeated_output` can see the
   * same answer arriving three times without ever holding three copies of the text (FR-GRD-009).
   */
  outputHashes: readonly string[];
}

export interface CostCheckInput {
  /** What was compared with the cap: the run's total, or the day's. */
  costUsd: number;
  /** The cap that applied, already resolved through `params.usd` → project → settings (D79). */
  capUsd: number;
  /** True when `costUsd` includes the next node's projected cost rather than money already spent. */
  projected: boolean;
}

/**
 * What a check answers. `passed: true` means the content is clean and the configured action is not
 * applied at all.
 *
 * `redactedTypes` names *what* was found — `email`, `api_key` — and never the value, which is the
 * whole of FR-GRD-014 and the reason `RedactedTypeSchema` refuses anything with a dash, an `@` or a
 * digit-heavy shape in it.
 */
export interface CheckOutcome {
  passed: boolean;
  reason: string;
  redactedTypes?: string[];
  /** The text with every finding replaced by `[<type> redacted]`, for a `redact` action. */
  sanitized?: string;
}

export interface CheckRunner {
  /**
   * Evaluate one check. `undefined` means this runner has no implementation for that check type —
   * the `tool` and `context` checks of rounds 4 and 5 are declared in a policy from today, and a
   * policy that carries them must neither crash the engine nor record a verdict it cannot justify.
   */
  evaluate(check: GuardrailCheck, input: CheckInput): CheckOutcome | undefined;
}

/** What the data guardrail found and removed. `text` is always safe to store and to pass on. */
export interface MaskResult {
  text: string;
  /** Type names only, in the order found, each at most once (FR-GRD-014). */
  types: string[];
}

/**
 * The data guardrail (FR-GRD-010, BR-07, BR-15, D86).
 *
 * Masks every credential-shaped string. It takes no check, no policy and no action, because there
 * is nothing to configure: with `secret_leak` set to `warn` the raw key would otherwise reach the
 * next node's envelope, which is stored, and `storage-local` refuses a credential-shaped write —
 * the run would die at the write rather than at the leak.
 */
export interface SecretMasker {
  mask(text: string): MaskResult;
}

/** A runner that implements nothing — the shape a round-4 check falls through to. */
export const NO_CHECKS: CheckRunner = { evaluate: () => undefined };

/** A masker that finds nothing. Only for tests that are not about masking. */
export const NO_MASKING: SecretMasker = { mask: (text) => ({ text, types: [] }) };
