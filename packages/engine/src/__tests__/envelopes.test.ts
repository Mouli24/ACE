import { AgentConfigSchema, type Node, type Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  TRUNCATED_SUMMARY,
  asDelivered,
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

const build = async (
  parts: Part[],
  budgetTokens = 4000,
  trust: 'trusted' | 'untrusted' = 'untrusted',
) =>
  (
    await buildEnvelope(
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
    )
  ).envelope;

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
      {
        type: 'file',
        artifactId: ARTIFACT,
        mime: 'application/pdf',
        name: 'b.pdf',
        size: 5_000_000,
      },
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
  it('is addressed from one node to another, in this iteration', async () => {
    const envelope = await build([{ type: 'text', text: 'hello' }]);

    expect(envelope.fromNodeId).toBe(NODE_A);
    expect(envelope.toNodeId).toBe(NODE_B);
    expect(envelope.iteration).toBe(1);
    expect(envelope.runId).toBe(RUN_ID);
  });

  it('carries the parts unchanged while they fit', async () => {
    const parts: Part[] = [
      { type: 'text', text: 'hello' },
      { type: 'json', value: { a: 1 } },
    ];

    expect((await build(parts)).reads).toEqual(parts);
  });

  it('carries no summary when nothing had to be dropped', async () => {
    expect((await build([{ type: 'text', text: 'short' }])).context.summary).toBeUndefined();
  });

  it('records the budget it was built against', async () => {
    expect((await build([{ type: 'text', text: 'x' }], 512)).context.budgetTokens).toBe(512);
  });

  it('records the trust of what it carries', async () => {
    expect((await build([{ type: 'text', text: 'x' }], 4000, 'trusted')).context.trust).toBe(
      'trusted',
    );
    expect((await build([{ type: 'text', text: 'x' }])).context.trust).toBe('untrusted');
  });

  it('has no field that could hold a message list (BR-02)', async () => {
    expect(Object.keys(await build([{ type: 'text', text: 'x' }]))).not.toContain('messages');
  });
});

describe('TC-EXE-006 an envelope never exceeds its budget', () => {
  /** 50k tokens of text, the fixture §4 item 13 calls `budget.json`. */
  const huge: Part[] = [{ type: 'text', text: 'word '.repeat(40_000) }];

  it('fits a 50k-token read into a 4000-token budget', async () => {
    const envelope = await build(huge, 4000);

    expect(estimatePartsTokens(envelope.reads)).toBeLessThanOrEqual(4000);
  });

  it('marks the envelope as truncated, so the agent knows it is not seeing everything', async () => {
    expect((await build(huge, 4000)).context.summary).toBe(TRUNCATED_SUMMARY);
  });

  it('keeps the head and the tail, because both ends carry the instruction and the conclusion', async () => {
    const text = `${'A'.repeat(20_000)}${'B'.repeat(20_000)}${'C'.repeat(20_000)}`;
    const envelope = await build([{ type: 'text', text }], 1000);
    const carried = envelope.reads
      .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('');

    expect(carried.startsWith('A')).toBe(true);
    expect(carried.endsWith('C')).toBe(true);
  });

  it('splits the budget roughly seventy-thirty between head and tail', async () => {
    const text = `${'A'.repeat(50_000)}${'C'.repeat(50_000)}`;
    const envelope = await build([{ type: 'text', text }], 1000);
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

  it('keeps artifact references rather than truncating them away', async () => {
    const envelope = await build(
      [
        { type: 'text', text: 'word '.repeat(40_000) },
        { type: 'file', artifactId: ARTIFACT, mime: 'application/pdf', name: 'b.pdf', size: 12 },
      ],
      1000,
    );

    expect(envelope.reads.some((part) => part.type === 'file')).toBe(true);
    expect(estimatePartsTokens(envelope.reads)).toBeLessThanOrEqual(1000);
  });

  it('is deterministic: the same oversized input truncates the same way twice', async () => {
    expect((await build(huge, 1000)).reads).toEqual((await build(huge, 1000)).reads);
  });

  it('leaves a tiny budget with something rather than nothing', async () => {
    const envelope = await build(huge, 8);

    expect(estimatePartsTokens(envelope.reads)).toBeLessThanOrEqual(8);
    expect(envelope.reads.length).toBeGreaterThan(0);
  });
});

describe('FR-EXE-007 the summariser is a port', () => {
  it('returns a promise from the truncating summariser, with the same result', async () => {
    const pending = createTruncatingSummariser().summarise({
      parts: [{ type: 'text', text: 'short' }],
      budgetTokens: 100,
    });

    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toEqual({ parts: [{ type: 'text', text: 'short' }] });
  });

  it('hands the summariser the receiving node model and the signal', async () => {
    const seen: unknown[] = [];
    const controller = new AbortController();
    await buildEnvelope(
      {
        id: ENVELOPE_ID,
        runId: RUN_ID,
        fromNodeId: NODE_A,
        toNodeId: NODE_B,
        iteration: 1,
        parts: [{ type: 'text', text: 'x' }],
        budgetTokens: 1,
        trust: 'untrusted',
        contract: { outputTypes: ['text'] },
        createdAt: NOW,
        target: { providerId: 'p1', modelId: 'm1' },
        signal: controller.signal,
      },
      {
        summarise: async (input) => {
          seen.push(input.target, input.signal);
          return { parts: [...input.parts] };
        },
      },
    );

    expect(seen).toEqual([{ providerId: 'p1', modelId: 'm1' }, controller.signal]);
  });

  it('can be replaced without touching the envelope builder', async () => {
    const { envelope } = await buildEnvelope(
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
      {
        summarise: async () => ({
          parts: [{ type: 'text', text: 'tl;dr' }],
          summary: 'summarised',
        }),
      },
    );

    expect(envelope.reads).toEqual([{ type: 'text', text: 'tl;dr' }]);
    expect(envelope.context.summary).toBe('summarised');
  });
});

describe('13b fix I1 asDelivered: a stored envelope back as it was delivered (FR-ERR-003, BR-13)', () => {
  const input = { id: NODE_A, kind: 'input' } as Node;
  const agent = {
    id: NODE_B,
    kind: 'agent',
    config: AgentConfigSchema.parse({
      providerId: NODE_A,
      modelId: 'mock-text',
      instructions: 'x',
      inputTypes: ['text'],
      outputTypes: ['text'],
      knowledgeBaseIds: [ARTIFACT],
      memory: { enabled: true },
      contextPolicy: { budgetTokens: 4000 },
    }),
  } as Node;

  it('takes the placed context off, trusts the Input again and states the reads budget', async () => {
    const delivered = await build([{ type: 'text', text: 'What is ACE?' }], 1000, 'trusted');
    const read = {
      ...delivered,
      context: {
        ...delivered.context,
        budgetTokens: 4000,
        trust: 'untrusted' as const,
        retrieved: [{ chunkId: ARTIFACT, text: 'chunk', score: 0.5, source: 'a.md#1' }],
        memory: [{ key: 'tone', value: 'brief' }],
      },
    };

    expect(asDelivered([read], [input, agent])).toEqual([delivered]);
  });

  it('an envelope as delivered comes back equal; an unknown node leaves trust and budget alone', async () => {
    const delivered = await build([{ type: 'text', text: 'draft' }], 1000, 'untrusted');

    expect(asDelivered([delivered], [input, agent])).toEqual([
      { ...delivered, context: { ...delivered.context, trust: 'trusted' } },
    ]);
    expect(asDelivered([delivered], [])).toEqual([delivered]);
  });
});
