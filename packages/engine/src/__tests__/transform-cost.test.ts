import type { Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { estimateCostUsd, sumUsage, usageFor } from '../runs/cost.js';
import { DEFAULT_JOIN_SEPARATOR, readPath, runTransform } from '../runs/transform.js';

const PRICING = { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' };

/* -------------------------------------------------------------------------- */
/* Cost                                                                        */
/* -------------------------------------------------------------------------- */

describe('FR-OBS-002 cost comes from tokens and the price table', () => {
  it('prices input and output separately', () => {
    expect(estimateCostUsd(1000, 1000, PRICING)).toBeCloseTo(0.003, 10);
  });

  it('prices a partial thousand proportionally', () => {
    expect(estimateCostUsd(500, 0, PRICING)).toBeCloseTo(0.0005, 10);
  });

  it('costs nothing when the model has no published price, which is what a local model is', () => {
    expect(estimateCostUsd(10_000, 10_000, undefined)).toBe(0);
  });

  it('FR-OBS-003 stamps the estimate with the table it used', () => {
    expect(usageFor(10, 20, PRICING).priceTableVersion).toBe('mock-v1');
    expect(usageFor(10, 20, undefined).priceTableVersion).toBeUndefined();
  });
});

describe('TC-OBS-002 run totals are the exact sum of the node runs', () => {
  it('adds tokens and cost', () => {
    const total = sumUsage([usageFor(10, 20, PRICING), usageFor(5, 7, PRICING)]);

    expect(total.tokensIn).toBe(15);
    expect(total.tokensOut).toBe(27);
    expect(total.costUsd).toBeCloseTo(estimateCostUsd(15, 27, PRICING), 12);
  });

  it('is zero for a run that did nothing', () => {
    expect(sumUsage([])).toEqual({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });

  it('keeps the price table version while every node agrees on one', () => {
    expect(sumUsage([usageFor(1, 1, PRICING), usageFor(2, 2, PRICING)]).priceTableVersion).toBe(
      'mock-v1',
    );
  });

  it('reports no version when a run spanned two tables, rather than picking one', () => {
    const other = { ...PRICING, priceTableVersion: 'mock-v2' };

    expect(sumUsage([usageFor(1, 1, PRICING), usageFor(1, 1, other)]).priceTableVersion).toBeUndefined();
  });

  it('ignores unpriced node runs when deciding the version', () => {
    expect(
      sumUsage([usageFor(1, 1, PRICING), usageFor(1, 1, undefined)]).priceTableVersion,
    ).toBe('mock-v1');
  });
});

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

describe('FR-NODE-013 the dotted path reader', () => {
  const value = { a: { b: [{ c: 'deep' }] }, n: 7, empty: null };

  it.each([
    ['a.b.0.c', 'deep'],
    ['a.b[0].c', 'deep'],
    ['n', 7],
    ['empty', null],
  ])('reads %s', (path, expected) => {
    expect(readPath(value, path)).toEqual(expected);
  });

  it('returns undefined for a path that is not there', () => {
    expect(readPath(value, 'a.missing')).toBeUndefined();
    expect(readPath(value, 'a.b.9.c')).toBeUndefined();
    expect(readPath(value, 'n.deeper')).toBeUndefined();
  });

  it('returns the whole value for an empty path', () => {
    expect(readPath(value, '')).toEqual(value);
  });
});

/* -------------------------------------------------------------------------- */
/* Transform                                                                   */
/* -------------------------------------------------------------------------- */

const json = (value: unknown): Part[] => [{ type: 'json', value }];
const text = (...values: string[]): Part[] => values.map((value) => ({ type: 'text', text: value }));

describe('FR-NODE-013 template', () => {
  it('fills slots from the json read', () => {
    const result = runTransform(
      { op: 'template', template: 'Hello {{name}}, you scored {{score}}.' },
      json({ name: 'Ada', score: 9 }),
    );

    expect(result).toEqual({ ok: true, parts: [{ type: 'text', text: 'Hello Ada, you scored 9.' }] });
  });

  it('reads a dotted path', () => {
    const result = runTransform(
      { op: 'template', template: '{{review.verdict}}' },
      json({ review: { verdict: 'approved' } }),
    );

    expect(result).toEqual({ ok: true, parts: [{ type: 'text', text: 'approved' }] });
  });

  it('parses a text read that happens to be JSON', () => {
    const result = runTransform(
      { op: 'template', template: '{{a}}' },
      text('{"a":"from text"}'),
    );

    expect(result).toEqual({ ok: true, parts: [{ type: 'text', text: 'from text' }] });
  });

  it('writes an empty string for a slot with nothing behind it', () => {
    const result = runTransform({ op: 'template', template: '[{{missing}}]' }, json({}));

    expect(result).toEqual({ ok: true, parts: [{ type: 'text', text: '[]' }] });
  });

  it('serialises a non-string value', () => {
    const result = runTransform({ op: 'template', template: '{{list}}' }, json({ list: [1, 2] }));

    expect(result).toEqual({ ok: true, parts: [{ type: 'text', text: '[1,2]' }] });
  });

  it('refuses a transform with no template', () => {
    expect(runTransform({ op: 'template' }, json({})).ok).toBe(false);
  });
});

describe('FR-NODE-013 extract_json_field', () => {
  it('pulls out one field as json', () => {
    expect(runTransform({ op: 'extract_json_field', path: 'review.score' }, json({ review: { score: 8 } }))).toEqual(
      { ok: true, parts: [{ type: 'json', value: 8 }] },
    );
  });

  it('pulls out a nested object whole', () => {
    expect(
      runTransform({ op: 'extract_json_field', path: 'review' }, json({ review: { score: 8 } })),
    ).toEqual({ ok: true, parts: [{ type: 'json', value: { score: 8 } }] });
  });

  it('fails, naming the path, when there is nothing there', () => {
    const result = runTransform({ op: 'extract_json_field', path: 'review.nope' }, json({}));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('review.nope');
  });

  it('refuses a transform with no path', () => {
    expect(runTransform({ op: 'extract_json_field' }, json({})).ok).toBe(false);
  });
});

describe('FR-NODE-013 join', () => {
  it('concatenates the text reads with the default separator', () => {
    expect(runTransform({ op: 'join' }, text('one', 'two'))).toEqual({
      ok: true,
      parts: [{ type: 'text', text: `one${DEFAULT_JOIN_SEPARATOR}two` }],
    });
  });

  it('uses the configured separator', () => {
    expect(runTransform({ op: 'join', separator: ' | ' }, text('a', 'b'))).toEqual({
      ok: true,
      parts: [{ type: 'text', text: 'a | b' }],
    });
  });

  it('ignores reads that are not text', () => {
    expect(runTransform({ op: 'join', separator: '+' }, [...text('a'), ...json({ b: 1 })])).toEqual({
      ok: true,
      parts: [{ type: 'text', text: 'a' }],
    });
  });

  it('produces an empty text part when there is nothing to join', () => {
    expect(runTransform({ op: 'join' }, [])).toEqual({ ok: true, parts: [{ type: 'text', text: '' }] });
  });
});
