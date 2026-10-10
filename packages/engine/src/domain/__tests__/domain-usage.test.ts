import type { UsageUpdatedPayload } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createRunDriverHarness, type Step } from '../../__tests__/run-driver-harness.js';

/*
 * Domain Gate 4 (D306, D313): every turn says what it used — the provider's own numbers when it
 * reports them, an estimate (characters ÷ 4) when it does not — on its node run and on
 * `usage.updated.turn`, so Track and Domain read the same numbers. Domain prices a turn from the
 * provider's reported cost, else `ace.pricing.json`, else not at all.
 */

async function writer(step: Step) {
  const h = await createRunDriverHarness();
  const node = h.agentNode('Writer');
  await h.seed([node], []);
  h.scripts.set('Writer', [step]);
  const done = await (await h.start()).done;
  const [row] = await h.nodeRunsOf(done.id, node.id);
  if (row === undefined) throw new Error('no node run');
  return { h, node, row, runId: done.id };
}

const turnOf = (h: { payloads: <T>(type: string) => T[] }, nodeRunId: string) =>
  h
    .payloads<UsageUpdatedPayload>('usage.updated')
    .find((each) => each.turn?.nodeRunId === nodeRunId)?.turn;

describe('D313 a turn says what it used', () => {
  it('a provider that reports nothing: the turn is estimated, characters ÷ 4, on its row and in the log', async () => {
    const { h, node, row } = await writer({ text: 'x'.repeat(40), usage: null });
    expect(row.usage).toMatchObject({ tokensOut: 10, source: 'estimated' });
    expect(row.usage.tokensIn).toBeGreaterThan(0);
    expect(turnOf(h, row.id)).toEqual({
      nodeRunId: row.id,
      nodeId: node.id,
      providerType: 'mock',
      modelId: 'scripted',
      usage: row.usage,
    });
  });

  it("a reported turn keeps the provider's own numbers: tokens, cached input and cost", async () => {
    const { h, row } = await writer({
      text: 'ok',
      usage: { tokensIn: 100, tokensOut: 10, cachedTokensIn: 60, costUsd: 0.25 },
    });
    expect(row.usage).toMatchObject({
      tokensIn: 100,
      tokensOut: 10,
      cachedTokensIn: 60,
      costUsd: 0.25,
      costSource: 'reported',
    });
    expect(row.usage.source).not.toBe('estimated');
    expect(turnOf(h, row.id)?.usage).toEqual(row.usage);
  });
});

describe('D306 Domain prices a turn from what was reported, else ace.pricing.json, else not at all', () => {
  it('reported cost, a missing price shown as null, and an estimate once the price is added', async () => {
    const h = await createRunDriverHarness();
    const writerNode = h.agentNode('Writer');
    const review = h.agentNode('Review');
    await h.seed([writerNode, review], [h.edge(writerNode, review)]);
    h.scripts.set('Writer', [
      { text: 'Draft.', usage: { tokensIn: 1000, tokensOut: 1000, costUsd: 0.5 } },
    ]);
    h.scripts.set('Review', [{ text: 'y'.repeat(80), usage: null }]);
    const done = await (await h.start()).done;

    const before = await h.usage(done.id);
    const of = (nodeId: string) => before.perNode.find((each) => each.nodeId === nodeId);
    expect(of(writerNode.id)).toMatchObject({
      source: 'reported',
      costEst: { usd: 0.5, source: 'reported', partial: false },
    });
    expect(of(review.id)).toMatchObject({ source: 'estimated', costEst: null, output: 20 });
    expect(before.total.estimatedShare).toBeGreaterThan(0);
    expect(before.costEst).toMatchObject({ usd: 0.5, partial: true });

    h.pricing.table = {
      models: [{ provider: 'mock', model: 'scripted', inputPer1M: 1, outputPer1M: 2 }],
    };
    const after = await h.usage(done.id);
    const reviewAfter = after.perNode.find((each) => each.nodeId === review.id);
    expect(reviewAfter?.costEst?.source).toBe('estimated');
    expect(reviewAfter?.costEst?.usd).toBeCloseTo(
      ((reviewAfter?.input ?? 0) * 1 + 20 * 2) / 1_000_000,
      12,
    );
    expect(after.costEst).toMatchObject({ source: 'mixed', partial: false });
  });
});
