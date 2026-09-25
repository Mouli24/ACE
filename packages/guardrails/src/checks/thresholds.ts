/**
 * The numeric threshold checks: `max_tokens_per_node`, `max_cost_per_run`, `daily_budget`,
 * `max_iterations`, `max_tool_calls` (FR-GRD-008, FR-GRD-009, round 3 §2.3, §2.4).
 *
 * All five read the same way and that is on purpose — one rule for the whole family:
 *
 *   **`value <= limit` passes; `value > limit` fails.**
 *
 * So `max_iterations { max: 50 }` allows iterations 1…50 and fails at 51; `max_tool_calls { max: 5 }`
 * allows five calls and fails on the sixth, which is TC-GRD-014's "stops at 5"; a run cap of $0.01
 * fails the moment the projected or actual total passes it, which is the HALT of FR-GRD-008.
 *
 * Where the cap comes from also follows one rule: the policy's own `params` first, then the caller's
 * `limit` — the project's `maxCostPerRunUsd`, the settings' `dailyBudgetUsd`, or the agent's
 * `execution.maxTokens` (round 3 §2.3). **No cap anywhere is a pass, not a failure**: a project with
 * no budget set has no budget to exceed.
 */

import type { GuardrailCheck } from '@ace/contracts';

import { numberParam, positiveIntParam } from '../params.js';
import type { CheckResult, GuardrailInput } from '../types.js';

/** The param keys each threshold type reads, in the order it reads them (round 3 §2.2's examples). */
const PARAM_KEYS: Readonly<Record<string, readonly string[]>> = {
  max_tokens_per_node: ['maxTokens', 'max'],
  max_cost_per_run: ['usd', 'maxCostUsd', 'max'],
  daily_budget: ['usd', 'dailyBudgetUsd', 'max'],
  max_iterations: ['max', 'maxIterations'],
  max_tool_calls: ['max', 'maxToolCalls'],
};

/** How each threshold's numbers read in a reason line, so a verdict is legible without a lookup. */
interface Wording {
  /** What the measured number is. */
  readonly noun: string;
  /** Renders a number — dollars want two decimals, counts do not. */
  readonly format: (value: number) => string;
  /** Whether the cap has to be a whole number ≥ 1 (a count) or may be fractional (dollars). */
  readonly integral: boolean;
}

const WORDING: Readonly<Record<string, Wording>> = {
  max_tokens_per_node: {
    noun: 'tokens for this node',
    format: count,
    integral: true,
  },
  max_cost_per_run: { noun: 'run cost', format: usd, integral: false },
  daily_budget: { noun: "today's spend", format: usd, integral: false },
  max_iterations: { noun: 'loop iterations', format: count, integral: true },
  max_tool_calls: { noun: 'tool calls', format: count, integral: true },
};

function count(value: number): string {
  return String(value);
}

function usd(value: number): string {
  const trimmed = value
    .toFixed(4)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
  return `$${trimmed}`;
}

/**
 * One threshold check. `undefined` means the input carried no number to judge — a cost check handed
 * nothing but text, for instance. Silence, not a pass.
 */
export function checkThreshold(
  check: GuardrailCheck,
  input: GuardrailInput,
  type: string = check.type,
): CheckResult | undefined {
  const value = input.value;
  if (value === undefined || !Number.isFinite(value)) return undefined;

  const wording = WORDING[type];
  if (wording === undefined) return undefined;

  const keys = PARAM_KEYS[type] ?? [];
  const fromParams = wording.integral
    ? positiveIntParam(check, ...keys)
    : nonNegative(numberParam(check, ...keys));
  const limit = fromParams ?? nonNegative(input.limit);

  if (limit === undefined) {
    return {
      passed: true,
      reason: `No ${type.replace(/_/g, ' ')} cap is configured.`,
    };
  }

  const measured = `${wording.format(value)} ${wording.noun}`;
  if (value <= limit) {
    return {
      passed: true,
      reason: `${measured} is within the cap of ${wording.format(limit)}.`,
    };
  }
  return {
    passed: false,
    reason: `${measured} exceeds the cap of ${wording.format(limit)}.`,
  };
}

function nonNegative(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** Per-node token cap — the agent's `execution.maxTokens` unless the policy names one (§2.3). */
export function checkMaxTokensPerNode(
  check: GuardrailCheck,
  input: GuardrailInput,
): CheckResult | undefined {
  return checkThreshold(check, input, 'max_tokens_per_node');
}

/** Run cost cap — the project's `maxCostPerRunUsd` unless the policy names `params.usd` (§2.3). */
export function checkMaxCostPerRun(
  check: GuardrailCheck,
  input: GuardrailInput,
): CheckResult | undefined {
  return checkThreshold(check, input, 'max_cost_per_run');
}

/** Daily budget — the settings' `dailyBudgetUsd` unless the policy names `params.usd` (§2.3). */
export function checkDailyBudget(
  check: GuardrailCheck,
  input: GuardrailInput,
): CheckResult | undefined {
  return checkThreshold(check, input, 'daily_budget');
}

/** Loop iteration cap, 1…50 by the contract's `LoopConfig` (FR-PAR-003, round 3 §2.4). */
export function checkMaxIterations(
  check: GuardrailCheck,
  input: GuardrailInput,
): CheckResult | undefined {
  return checkThreshold(check, input, 'max_iterations');
}

/**
 * Tool-call cap (FR-GRD-009, TC-GRD-014). This round it is a counter check with a unit test and
 * nothing calls it yet; Round 4's tool loop is what enforces it, and it will hand this function the
 * number of calls the node has made so far.
 */
export function checkMaxToolCalls(
  check: GuardrailCheck,
  input: GuardrailInput,
): CheckResult | undefined {
  return checkThreshold(check, input, 'max_tool_calls');
}
