import { describe, expect, it } from 'vitest';

import { passesLuhn } from '../rule-packs/pii.js';
import { describeSpans, findSpans, redactSpans, type RulePack } from '../spans.js';

/**
 * The machinery under every rule pack (FR-GRD-003, FR-GRD-007). Worth its own tests because the
 * overlap rule is what decides *which type name* a verdict carries, and a wrong type name on a
 * verdict is a wrong thing on the user's screen.
 */
describe('FR-GRD-014 span machinery', () => {
  const pack: RulePack = [
    { type: 'specific', pattern: /alpha-beta/g },
    { type: 'general', pattern: /beta/g },
  ];

  it('gives an overlap to the earlier rule in the pack', () => {
    const spans = findSpans('say alpha-beta now', pack);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.type).toBe('specific');
  });

  it('still matches the later rule where the earlier one does not reach', () => {
    const spans = findSpans('alpha-beta and beta', pack);
    expect(spans.map((span) => span.type)).toEqual(['specific', 'general']);
  });

  it('returns spans in document order', () => {
    const spans = findSpans('beta … alpha-beta', pack);
    expect(spans.map((span) => span.start)).toEqual([0, 7]);
  });

  it('never returns the matched text — a Span carries offsets and a type, nothing else', () => {
    const spans = findSpans('alpha-beta', pack);
    expect(Object.keys(spans[0] ?? {}).sort()).toEqual(['end', 'priority', 'start', 'type']);
  });

  it('redacts back to front so the earlier offsets stay valid', () => {
    const spans = findSpans('beta x alpha-beta y beta', pack);
    const { sanitized, count } = redactSpans('beta x alpha-beta y beta', spans);
    expect(count).toBe(3);
    expect(sanitized).toBe('[general redacted] x [specific redacted] y [general redacted]');
  });

  it('lists the redacted types in pack order, deduplicated', () => {
    const { redactedTypes } = redactSpans(
      'beta alpha-beta beta',
      findSpans('beta alpha-beta beta', pack),
    );
    expect(redactedTypes).toEqual(['specific', 'general']);
  });

  it('leaves text with nothing to redact byte-identical', () => {
    const text = 'nothing here to find';
    const { sanitized, redactedTypes, count } = redactSpans(text, findSpans(text, pack));
    expect(sanitized).toBe(text);
    expect(redactedTypes).toEqual([]);
    expect(count).toBe(0);
  });

  it('counts and names in a reason line without quoting anything', () => {
    const spans = findSpans('beta alpha-beta beta', pack);
    expect(describeSpans(spans)).toBe('1 specific, 2 general');
  });

  it('survives a pattern that can match empty — no infinite loop', () => {
    const empties: RulePack = [{ type: 'empty', pattern: /x*/g }];
    expect(() => findSpans('abc', empties)).not.toThrow();
  });

  it('drops a match its rule refuses to verify', () => {
    const verified: RulePack = [
      { type: 'odd', pattern: /\d+/g, verify: (m) => Number(m) % 2 === 1 },
    ];
    const spans = findSpans('2 3 4 5', verified);
    expect(spans).toHaveLength(2);
  });

  it('redacts only the capture group when a rule names one', () => {
    const grouped: RulePack = [{ type: 'value', pattern: /key=(\w+)/g, group: 1 }];
    const text = 'key=abc123';
    const { sanitized } = redactSpans(text, findSpans(text, grouped));
    expect(sanitized).toBe('key=[value redacted]');
  });

  it('ignores a capture group that did not participate in the match', () => {
    const optional: RulePack = [{ type: 'value', pattern: /key(?:=(\w+))?/g, group: 1 }];
    expect(findSpans('key', optional)).toEqual([]);
  });
});

describe('FR-GRD-003 the Luhn check behind the card rule', () => {
  it.each(['4111 1111 1111 1111', '5555555555554444', '4111-1111-1111-1111'])(
    'accepts %s',
    (candidate) => {
      expect(passesLuhn(candidate)).toBe(true);
    },
  );

  it.each(['4111 1111 1111 1112', '1234567890123', '123', '1'.repeat(20)])(
    'rejects %s',
    (candidate) => {
      expect(passesLuhn(candidate)).toBe(false);
    },
  );
});
