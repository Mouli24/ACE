/**
 * Reading a check's `params` (round 3 §2.2).
 *
 * `GuardrailCheck.params` is `Record<string, unknown>` in the contract — deliberately open, because
 * each check type names its own keys. Open means "could be anything", so every read goes through
 * one of these: a wrong type in a policy has to be a check that declines to judge, never a `NaN`
 * comparison that quietly passes.
 */

import type { GuardrailCheck } from '@ace/contracts';

/** A finite number under `key`, or `undefined` — a string, a `NaN` and a missing key are all that. */
export function numberParam(check: GuardrailCheck, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const raw = check.params[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return undefined;
}

/** An integer ≥ 1 under `key`, or `undefined`. Used for counts: `times`, `max`, `maxChars`. */
export function positiveIntParam(
  check: GuardrailCheck,
  ...keys: readonly string[]
): number | undefined {
  const value = numberParam(check, ...keys);
  if (value === undefined || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

/** The non-empty strings under `key`, or `[]`. Anything that is not a string is dropped. */
export function stringArrayParam(check: GuardrailCheck, key: string): string[] {
  const raw = check.params[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
