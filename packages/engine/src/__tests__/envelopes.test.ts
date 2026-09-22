import type { Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  TRUNCATED_SUMMARY,
  buildEnvelope,
  createTruncatingSummariser,
  estimatePartsTokens,
  estimateTokens,
  trustForSource,
} from '../envelopes/index.js';

const NOW = '2026-09-22T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_A = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const NODE_B = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const ENVELOPE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ENVP';
const ARTIFACT = '01JBXQ8Z9KQ4R7N2VWXYZ0ARTF';

const build = (parts: Part[], budgetTokens = 4000, trust: 'trusted' | 'untrusted' = 'untrusted') =>
  buildEnvelope(
    {
      id: ENVELOPE_ID,
      runId: RUN_ID,
      fromNodeId: NODE_A,
      toNodeId: NODE_B,
      iteration: 1,
      parts,
      budgetTokens,
      trust,
      contract: { outputTypes: ['text'] },
      createdAt: NOW,
    },
    createTruncatingSummariser(),
  );

describe('FR-EXE-007 the token estimate is characters over four', () => {
  it('estimates a short string', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('rounds up, so a budget is never overshot by a rounding error', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('estimates an empty string as nothing', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('measures a json part by its serialised form', () => {
    expect(estimatePartsTokens([{ type: 'json', value: { a: 1 } }])).toBeGreaterThan(0);
  });

  it('measures an artifact reference by its name, not its bytes', () => {
    const tokens = estimatePartsTokens([
      { type: 'file', artifactId: ARTIFACT, mime: 'application/pdf', name: 'b.pdf', size: 5_000_000 },
    ]);

    expect(tokens).toBeLessThan(10);
  });
});

describe('BR-13 trust follows where the content came from', () => {
  it('trusts what an Input node carries, because the user typed it', () => {
    expect(trustForSource('input')).toBe('trusted');
  });

  it.each(['agent', 'model', 'transform', 'merge', 'retrieval', 'output'] as const)(
    'does not trust output from a %s node',
    (kind) => {
      expect(trustForSource(kind)).toBe('untrusted');
    },
  );
});

describe('FR-EXE-005 an envelope carries the upstream output', () => {
  it('is addressed from one node to another, in this iteration', () => {
    const envelope = build([{ type: 'text', text: 'hello' }]);

    expect(envelope.fromNodeId).toBe(NODE_A);
    expect(envelope.toNodeId).toBe(NODE_B);
    expect(envelope.iteration).toBe(1);
    expect(envelope.runId).toBe(RUN_ID);
  });

  it('carries the parts unchanged while they fit', () => {
    const parts: Part[] = [
      { type: 'text', text: 'hello' },
      { type: 'json', value: { a: 1 } },
    ];

    expect(build(parts).reads).toEqual(parts);
  });

  it('carries no summary when nothing had to be dropped', () => {
    expect(build([{ type: 'text', text: 'short' }]).context.summary).toBeUndefined();
  });

  it('records the budget it was built against', () => {
    expect(build([{ type: 'text', text: 'x' }], 512).context.budgetTokens).toBe(512);
  });

  it('records the trust of what it carries', () => {
    expect(build([{ type: 'text', text: 'x' }], 4000, 'trusted').context.trust).toBe('trusted');
    expect(build([{ type: 'text', text: 'x' }]).context.trust).toBe('untrusted');
  });

  it('has no field that could hold a message list (BR-02)', () => {
    expect(Object.keys(build([{ type: 'text', text: 'x' }]))).not.toContain('messages');
  });
});

describe('TC-EXE-006 an envelope never exceeds its budget', () => {
  /** 50k tokens of text, the fixture §4 item 13 calls `budget.json`. */
  const huge: Part[] = [{ type: 'text', text: 'word '.repeat(40_000) }];

  it('fits a 50k-token read into a 4000-token budget', () => {
    const envelope = build(huge, 4000);

    expect(estimatePartsTokens(envelope.reads)).toBeLessThanOrEqual(4000);
  });

  it('marks the envelope as truncated, so the agent knows it is not seeing everything', () => {
    expect(build(huge, 4000).context.summary).toBe(TRUNCATED_SUMMARY);
  });

  it('keeps the head and the tail, because both ends carry the instruction and the conclusion', () => {
    const text = `${'A'.repeat(20_000)}${'B'.repeat(20_000)}${'C'.repeat(20_000)}`;
    const envelope = build([{ type: 'text', text }], 1000);
    const carried = envelope.reads
      .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');

    expect(carried.startsWith('A')).toBe(true);
    expect(carried.endsWith('C')).toBe(true);
  });

  it('splits the budget roughly seventy-thirty between head and tail', () => {
    const text = `${'A'.repeat(50_000)}${'C'.repeat(50_000)}`;
    const envelope = build([{ type: 'text', text }], 1000);
    const carried = envelope.reads
      .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');

    const heads = (carried.match(/A/g) ?? []).length;
    const tails = (carried.match(/C/g) ?? []).length;

    expect(heads).toBeGreaterThan(tails);
    expect(heads / (heads + tails)).toBeGreaterThan(0.6);
    expect(heads / (heads + tails)).toBeLessThan(0.8);
  });

  it('keeps artifact references rather than truncating them away', () => {
    const envelope = build(
      [
        { type: 'text', text: 'word '.repeat(40_000) },
        { type: 'file', artifactId: ARTIFACT, mime: 'application/pdf', name: 'b.pdf', size: 12 },
      ],
      1000,
    );

    expect(envelope.reads.some((part) => part.type === 'file')).toBe(true);
    expect(estimatePartsTokens(envelope.reads)).toBeLessThanOrEqual(1000);
  });

  it('is deterministic: the same oversized input truncates the same way twice', () => {
    expect(build(huge, 1000).reads).toEqual(build(huge, 1000).reads);
  });

  it('leaves a tiny budget with something rather than nothing', () => {
    const envelope = build(huge, 8);

    expect(estimatePartsTokens(envelope.reads)).toBeLessThanOrEqual(8);
    expect(envelope.reads.length).toBeGreaterThan(0);
  });
});

describe('FR-EXE-007 the summariser is a port', () => {
  it('can be replaced without touching the envelope builder', () => {
    const envelope = buildEnvelope(
      {
        id: ENVELOPE_ID,
        runId: RUN_ID,
        fromNodeId: NODE_A,
        toNodeId: NODE_B,
        iteration: 1,
        parts: [{ type: 'text', text: 'anything at all' }],
        budgetTokens: 1,
        trust: 'untrusted',
        contract: { outputTypes: ['text'] },
        createdAt: NOW,
      },
      { summarise: () => ({ parts: [{ type: 'text', text: 'tl;dr' }], summary: 'summarised' }) },
    );

    expect(envelope.reads).toEqual([{ type: 'text', text: 'tl;dr' }]);
    expect(envelope.context.summary).toBe('summarised');
  });
});
