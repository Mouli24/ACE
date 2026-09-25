/**
 * The `contract` output check (FR-GRD-007, FR-EXE-006, TC-EXE-005).
 *
 * This one has no rules of its own. `validateAgainstContract` in `@ace/contracts` is the single
 * definition of what satisfies an output contract — the same function the executor calls — and this
 * check only puts its answer into the `CheckResult` shape so it can sit in a policy next to the
 * others. Reimplementing it here would be two answers to one question.
 *
 * One thing the engine must not lose in the translation: a *contract* failure is
 * `CONTRACT_VIOLATION`, and a *guardrail* failure is `GUARDRAIL_VIOLATION`. They are distinct states
 * (BR-03, BR-12, FR-GRD-012, D9), so this check's `passed: false` maps to `CONTRACT_VIOLATION` even
 * though it arrives through the guardrail pipeline.
 */

import { validateAgainstContract } from '@ace/contracts';

import type { CheckResult, GuardrailInput } from '../types.js';

export function checkContract(input: GuardrailInput): CheckResult | undefined {
  const { parts, contract } = input;
  if (parts === undefined || contract === undefined) return undefined;

  const outcome = validateAgainstContract([...parts], contract);
  if (outcome.ok) {
    return {
      passed: true,
      reason: `Output satisfies the contract [${contract.outputTypes.join(', ')}].`,
    };
  }
  return { passed: false, reason: outcome.reason };
}
