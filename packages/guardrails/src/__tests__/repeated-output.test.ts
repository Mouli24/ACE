import { describe, expect, it } from 'vitest';

import { checkRepeatedOutput, DEFAULT_REPEAT_TIMES } from '../checks/loop.js';
import { makeCheck } from './fixtures.js';

/**
 * FR-GRD-009: "Identical output 3 times in a row stops the loop" (TC-GRD-013). The check is pure —
 * it is handed the hashes, oldest first, and never the outputs.
 */
describe('TC-GRD-013 Repeated output', () => {
  const hash = (label: string): string => `h_${label}`;

  it('defaults to three', () => {
    expect(DEFAULT_REPEAT_TIMES).toBe(3);
    const check = makeCheck('repeated_output');
    expect(checkRepeatedOutput(check, { outputHashes: [hash('a'), hash('a')] })?.passed).toBe(true);
    expect(
      checkRepeatedOutput(check, {
        outputHashes: [hash('a'), hash('a'), hash('a')],
      })?.passed,
    ).toBe(false);
  });

  it('fails on the third identical output in a row and says so without quoting it', () => {
    const check = makeCheck('repeated_output', { times: 3 }, { action: 'block' });
    const result = checkRepeatedOutput(check, {
      outputHashes: [hash('x'), hash('a'), hash('a'), hash('a')],
    });

    expect(result).toEqual({
      passed: false,
      reason: 'The same output was produced 3 times in a row, at the limit of 3.',
    });
  });

  it('counts only a run, so an output in between resets it — "in a row" is the wording', () => {
    const check = makeCheck('repeated_output', { times: 3 });
    const result = checkRepeatedOutput(check, {
      outputHashes: [hash('a'), hash('a'), hash('b'), hash('a')],
    });
    expect(result?.passed).toBe(true);
    expect(result?.reason).toBe('The last 1 of 4 output(s) are identical; the limit is 3.');
  });

  it('honours a policy that asks for two', () => {
    const check = makeCheck('repeated_output', { times: 2 });
    expect(checkRepeatedOutput(check, { outputHashes: [hash('a'), hash('a')] })?.passed).toBe(
      false,
    );
  });

  it('is fine with no history at all', () => {
    const check = makeCheck('repeated_output', { times: 3 });
    const result = checkRepeatedOutput(check, { outputHashes: [] });
    expect(result?.passed).toBe(true);
    expect(result?.reason).toBe('The last 0 of 0 output(s) are identical; the limit is 3.');
  });

  it('says nothing when it was handed no hashes at all', () => {
    expect(
      checkRepeatedOutput(makeCheck('repeated_output'), { text: 'an output' }),
    ).toBeUndefined();
  });

  it('ignores a times that is not a positive integer', () => {
    for (const times of [0, -1, 1.5, '3', null]) {
      const check = makeCheck('repeated_output', { times });
      const result = checkRepeatedOutput(check, {
        outputHashes: [hash('a'), hash('a')],
      });
      expect(result?.passed).toBe(true);
    }
  });
});
