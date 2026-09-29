import { describe, expect, it } from 'vitest';

import { checkPii } from '../checks/text.js';
import { makeCheck, SAMPLE_PAN, SAMPLE_SSN } from './fixtures.js';

/**
 * TC-GRD-004 / FR-GRD-003 — the `national_id` rules of the PII pack. Round 3 §4 item 3 asks for
 * "national-id-like regex packs"; a US SSN, an Indian PAN and a UK National Insurance number are
 * three distinctly shaped, widely used ones. `QQ` is the prefix HMRC's own specimens use, so the
 * rule accepts any two letters rather than only the prefixes HMRC allocates.
 */
const run = (text: string) => checkPii(makeCheck('pii'), text);

describe('TC-GRD-004 a national id is found and named by type only', () => {
  it.each([
    ['a UK NI number', 'QQ123456C'],
    ['a UK NI number written in pairs', 'QQ 12 34 56 C'],
    ['a US SSN', SAMPLE_SSN],
    ['an Indian PAN', SAMPLE_PAN],
  ])('finds %s', (_label, value) => {
    const result = run(`ref ${value} end`);
    expect(result.redactedTypes).toEqual(['national_id']);
    expect(result.sanitized).toBe('ref [national_id redacted] end');
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it.each([
    ['a suffix letter past D', 'QQ123456E'],
    ['a lower-case look-alike', 'qq123456c'],
    ['the shape inside a longer code', 'XQQ123456C7'],
  ])('leaves %s alone', (_label, value) => {
    expect(run(`ref ${value} end`).passed).toBe(true);
  });
});
