/**
 * `evaluateCheck` — the one entry point the engine calls (round 3 §4 item 3).
 *
 * The engine builds a `GuardrailInput` for the point it is at and calls this for every enabled check
 * of the resolved policy; it then turns each `CheckResult` into a `Verdict` and applies
 * `check.action` (Arch §13.3, FR-GRD-011, FR-GRD-015).
 *
 * Two rules make the dispatch safe:
 *
 *  1. **`undefined` is silence, not a pass.** A cost check handed nothing but text, or a `contract`
 *     check handed no parts, has nothing to say — and the engine must not record a passing verdict
 *     for a check that never ran.
 *  2. **The switch is exhaustive over `GuardrailCheckType`.** The `never` assignment at the bottom
 *     means adding a check type to the contract is a *type error here* rather than a check that
 *     silently passes for the rest of the build.
 */

import type { GuardrailCheck, GuardrailCheckType } from '@ace/contracts';

import { checkContract } from './checks/contract.js';
import { checkRepeatedOutput } from './checks/loop.js';
import {
  checkDestructiveAction,
  checkDomainAllowlist,
  checkPathConfinement,
  checkToolAllowed,
} from './checks/tools.js';
import {
  checkBlockedTopics,
  checkModeration,
  checkPii,
  checkPromptInjection,
  checkRequiredCitations,
  checkSecretLeak,
  checkSizeLimit,
} from './checks/text.js';
import {
  checkDailyBudget,
  checkMaxCostPerRun,
  checkMaxIterations,
  checkMaxToolCalls,
  checkMaxTokensPerNode,
} from './checks/thresholds.js';
import type { CheckResult, GuardrailInput } from './types.js';

/**
 * The check types this package evaluates. The rest are declared in the contract for the rounds that
 * implement them — `untrusted_tagging` is the context point (Round 5) — and `evaluateCheck` answers
 * `undefined` for them rather than pretending. The four `tool` checks joined this list in Round 4.
 */
export const EVALUATED_CHECK_TYPES = [
  'size_limit',
  'pii',
  'prompt_injection',
  'blocked_topics',
  'contract',
  'moderation',
  'secret_leak',
  'required_citations',
  'max_tokens_per_node',
  'max_cost_per_run',
  'daily_budget',
  'max_iterations',
  'max_tool_calls',
  'repeated_output',
  'tool_allowed',
  'path_confinement',
  'domain_allowlist',
  'destructive_action',
] as const satisfies readonly GuardrailCheckType[];

export type EvaluatedCheckType = (typeof EVALUATED_CHECK_TYPES)[number];

/**
 * The order the output point runs its checks in: secret_leak → pii → moderation →
 * required_citations → contract (round 3 §4 item 4). The leak check goes first so that a credential
 * is caught before anything else has a chance to quote the output into a reason or a repair prompt.
 * Exported so the run path and `POST /guardrail-policies/:id/test` cannot order them differently.
 */
export const OUTPUT_CHECK_ORDER = [
  'secret_leak',
  'pii',
  'moderation',
  'required_citations',
  'contract',
] as const satisfies readonly GuardrailCheckType[];

/** Sort a point's checks into `OUTPUT_CHECK_ORDER`; anything not listed keeps its policy order. */
export function inOutputOrder(checks: readonly GuardrailCheck[]): GuardrailCheck[] {
  const rank = (type: GuardrailCheckType): number => {
    const index = (OUTPUT_CHECK_ORDER as readonly GuardrailCheckType[]).indexOf(type);
    return index === -1 ? OUTPUT_CHECK_ORDER.length : index;
  };
  return checks
    .map((check, position) => ({ check, position }))
    .sort((a, b) => rank(a.check.type) - rank(b.check.type) || a.position - b.position)
    .map(({ check }) => check);
}

/** Whether `evaluateCheck` can judge this type at all in this round. */
export function isEvaluated(type: GuardrailCheckType): type is EvaluatedCheckType {
  return (EVALUATED_CHECK_TYPES as readonly GuardrailCheckType[]).includes(type);
}

export function evaluateCheck(
  check: GuardrailCheck,
  input: GuardrailInput,
): CheckResult | undefined {
  // A check the policy has switched off has nothing to say. The engine normally filters first; this
  // is the second lock, because a disabled check that still produced a verdict would be a defect
  // the UI would show as a warning nobody configured.
  if (!check.enabled) return undefined;

  const text = input.text;

  switch (check.type) {
    /* ---- input / output text checks ------------------------------------- */
    case 'size_limit':
      return text === undefined ? undefined : checkSizeLimit(check, text);
    case 'pii':
      return text === undefined ? undefined : checkPii(check, text);
    case 'prompt_injection':
      return text === undefined ? undefined : checkPromptInjection(check, text);
    case 'blocked_topics':
      return text === undefined ? undefined : checkBlockedTopics(check, text);
    case 'moderation':
      return text === undefined ? undefined : checkModeration(check, text);
    case 'secret_leak':
      return text === undefined ? undefined : checkSecretLeak(check, text);
    case 'required_citations':
      return text === undefined ? undefined : checkRequiredCitations(check, text);

    /* ---- output contract ------------------------------------------------ */
    case 'contract':
      return checkContract(input);

    /* ---- cost ----------------------------------------------------------- */
    case 'max_tokens_per_node':
      return checkMaxTokensPerNode(check, input);
    case 'max_cost_per_run':
      return checkMaxCostPerRun(check, input);
    case 'daily_budget':
      return checkDailyBudget(check, input);

    /* ---- loop ----------------------------------------------------------- */
    case 'max_iterations':
      return checkMaxIterations(check, input);
    case 'max_tool_calls':
      return checkMaxToolCalls(check, input);
    case 'repeated_output':
      return checkRepeatedOutput(check, input);

    /* ---- tool ----------------------------------------------------------- */
    case 'tool_allowed':
      return checkToolAllowed(input);
    case 'path_confinement':
      return checkPathConfinement(input);
    case 'domain_allowlist':
      return checkDomainAllowlist(input);
    case 'destructive_action':
      return checkDestructiveAction(input);

    /* ---- declared now, evaluated in Round 5 ----------------------------- */
    case 'untrusted_tagging':
      return undefined;

    default: {
      // Adding a GuardrailCheckType without handling it above fails to compile here.
      const unhandled: never = check.type;
      return unhandled;
    }
  }
}

/**
 * Every check of a policy against one input, in the policy's own order, with the silent ones dropped.
 * The engine still decides what each `action` does; this is only the loop, written once so the
 * evaluation order in a run and in `POST /guardrail-policies/:id/test` cannot differ.
 */
export function evaluateChecks(
  checks: readonly GuardrailCheck[],
  input: GuardrailInput,
): { check: GuardrailCheck; result: CheckResult }[] {
  const evaluated: { check: GuardrailCheck; result: CheckResult }[] = [];
  for (const check of checks) {
    const result = evaluateCheck(check, input);
    if (result !== undefined) evaluated.push({ check, result });
  }
  return evaluated;
}
