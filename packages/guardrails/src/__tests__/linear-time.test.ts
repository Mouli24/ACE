import { describe, expect, it } from 'vitest';

import { checkPii } from '../checks/text.js';
import { makeCheck, SAMPLE_EMAIL } from './fixtures.js';

/**
 * TC-NFR-013 / NFR-SAFE-01 against adversarial text: "Guardrail checks add under 300 ms per node".
 *
 * `performance.test.ts` measures realistic text. These inputs are the other half — text shaped so a
 * pattern with an unbounded run rescans the rest of the input from every position. On the quadratic
 * versions they measured 2.0 s (`a.` × 20 000), 6.5 s (64 KB of hex) and 14.6 s (100 KB of letters);
 * linear scans take tens of milliseconds. The bound is 1 s rather than 300 ms so a loaded CI runner
 * cannot fail it spuriously, while every quadratic blow-up still fails it by a wide margin.
 */
const BOUND_MS = 1_000;

function timed<T>(run: () => T): { result: T; ms: number } {
  const started = performance.now();
  const result = run();
  return { result, ms: performance.now() - started };
}

/** Deterministic hex, so the input is the same on every run. */
function hex(length: number): string {
  return Array.from({ length }, (_, index) => ((index * 7 + 3) % 16).toString(16)).join('');
}

function letters(length: number): string {
  return 'abcdefghijklmnopqrstuvwxyz'.repeat(Math.ceil(length / 26)).slice(0, length);
}

describe('TC-NFR-013 the email rule scans adversarial text in linear time (NFR-SAFE-01)', () => {
  it.each([
    ['a long run of dotted words', 'a.'.repeat(20_000)],
    ['64 KB of hex', hex(64 * 1024)],
    ['100 KB of letters', letters(100_000)],
  ])('judges %s in under a second', (_label, text) => {
    const { result, ms } = timed(() => checkPii(makeCheck('pii'), text));
    expect(result.passed).toBe(true);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('still finds an email that follows the adversarial run', () => {
    const text = `${'a.'.repeat(20_000)} write to ${SAMPLE_EMAIL} today`;
    const { result, ms } = timed(() => checkPii(makeCheck('pii'), text));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(result.redactedTypes).toEqual(['email']);
    expect(result.sanitized?.endsWith(' write to [email redacted] today')).toBe(true);
  });

  it('still redacts an address glued to a long run, as the unanchored pattern did', () => {
    const result = checkPii(makeCheck('pii'), `Owner ${'.'.repeat(80)}${SAMPLE_EMAIL} (desk 4)`);
    expect(result.sanitized).toBe('Owner [email redacted] (desk 4)');
  });
});
