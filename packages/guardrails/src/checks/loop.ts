/**
 * `repeated_output` — the loop guardrail of FR-GRD-009 ("Identical output 3 times in a row stops the
 * loop", TC-GRD-013).
 *
 * Pure, and deliberately hash-based: the check never sees a node's output, only the hashes the
 * engine already computes for it. That keeps the function cheap on a hot path and keeps output text
 * out of a guardrail's arguments.
 *
 * `outputHashes` is **oldest first** — the engine appends each completed iteration's hash — and the
 * check looks only at the tail, because FR-GRD-009 says *in a row*. Three identical outputs with a
 * different one between them are not a stuck loop.
 */

import type { GuardrailCheck } from '@ace/contracts';

import { positiveIntParam } from '../params.js';
import type { CheckResult, GuardrailInput } from '../types.js';

/** FR-GRD-009's "3 times in a row", and the default policy's `repeated_output { times: 3 }`. */
export const DEFAULT_REPEAT_TIMES = 3;

export function checkRepeatedOutput(
  check: GuardrailCheck,
  input: GuardrailInput,
): CheckResult | undefined {
  const hashes = input.outputHashes;
  if (hashes === undefined) return undefined;

  const times = positiveIntParam(check, 'times') ?? DEFAULT_REPEAT_TIMES;
  const runLength = trailingRunLength(hashes);

  if (runLength >= times) {
    return {
      passed: false,
      reason: `The same output was produced ${runLength} times in a row, at the limit of ${times}.`,
    };
  }
  return {
    passed: true,
    reason: `The last ${runLength} of ${hashes.length} output(s) are identical; the limit is ${times}.`,
  };
}

/** How many of the most recent hashes are the same. `[]` is 0, `[a]` is 1, `[a,b,b]` is 2. */
function trailingRunLength(hashes: readonly string[]): number {
  const last = hashes[hashes.length - 1];
  if (last === undefined) return 0;

  let run = 1;
  for (let i = hashes.length - 2; i >= 0; i -= 1) {
    if (hashes[i] !== last) break;
    run += 1;
  }
  return run;
}
