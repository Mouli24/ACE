import { describe, expect, it } from 'vitest';

import { checkBlockedTopics, checkPii } from '../checks/text.js';
import { describeSpans, findSpans, redactSpans, type RulePack } from '../spans.js';
import { makeCheck } from './fixtures.js';

/**
 * FR-GRD-014 — a redaction must remove everything a check found. Two findings that only partly
 * overlap used to keep the higher-priority one and drop the other whole, so the part of the dropped
 * finding outside the kept one survived into `sanitized`. The redacted region is now their union;
 * the earliest rule in the pack still names it, and the reason counts one finding per marker.
 */
describe('FR-GRD-014 findings that partly overlap are redacted as their union', () => {
  const pack: RulePack = [
    { type: 'first', pattern: /beta-gamma/g },
    { type: 'second', pattern: /alpha-beta/g },
    { type: 'third', pattern: /gamma-delta/g },
  ];

  it('redacts the whole union, named by the earlier rule even when it starts later', () => {
    const text = 'say alpha-beta-gamma now';
    const spans = findSpans(text, pack);
    const { sanitized, redactedTypes, count } = redactSpans(text, spans);

    expect(sanitized).toBe('say [first redacted] now');
    expect(redactedTypes).toEqual(['first']);
    expect(count).toBe(1);
    expect(describeSpans(spans)).toBe('1 first');
  });

  it('joins a chain of overlaps into one region', () => {
    const text = 'x alpha-beta-gamma-delta y';
    const { sanitized, count } = redactSpans(text, findSpans(text, pack));
    expect(sanitized).toBe('x [first redacted] y');
    expect(count).toBe(1);
  });

  it('keeps spans that only touch as two redactions', () => {
    const touching: RulePack = [
      { type: 'left', pattern: /ab/g },
      { type: 'right', pattern: /cd/g },
    ];
    const { sanitized, count } = redactSpans('abcd', findSpans('abcd', touching));
    expect(sanitized).toBe('[left redacted][right redacted]');
    expect(count).toBe(2);
  });

  it('leaves no part of a phone number glued to an email behind', () => {
    const result = checkPii(makeCheck('pii'), 'Call +1 555 123 4567.ada@example.com today');

    expect(result.sanitized).toBe('Call [email redacted] today');
    expect(result.redactedTypes).toEqual(['email']);
    expect(result.reason).toBe('Personal data detected: 1 email.');
  });
});

describe('FR-GRD-003 blocked_topics that partly overlap are redacted as their union', () => {
  it('redacts both topics and the text between them', () => {
    const check = makeCheck('blocked_topics', { patterns: ['salary band', 'band review notes'] });
    const result = checkBlockedTopics(check, 'Please review the salary band review notes');

    expect(result.sanitized).toBe('Please review the [blocked_topic redacted]');
    expect(result.reason).toBe('2 of 2 blocked topics appear, 2 time(s) in total.');
    expect(result.redactedTypes).toEqual(['blocked_topic']);
  });

  it('joins a chain of overlapping topics into one redaction', () => {
    const check = makeCheck('blocked_topics', { patterns: ['one two', 'two three', 'three four'] });
    const result = checkBlockedTopics(check, 'say one two three four five');
    expect(result.sanitized).toBe('say [blocked_topic redacted] five');
  });
});
