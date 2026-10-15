/**
 * PG-1.4 cost rule (docs/team-prompts/product-gaps-fix-prompt.md): local models cost $0 by rule,
 * and an unpriced remote model's cost is **unknown**, never $0.
 *
 * Phase 0 red tests, at the seam where a node run's cost is decided: the executor prices the call
 * with `usageFor(tokensIn, tokensOut, pricing)` (`runs/cost.ts`), which answers 0 whenever the
 * catalog row has no price and prices whatever row has one, local or not. Every display (Inspector,
 * RunBar, Runs list, usage) reads the recorded `usage`, so the rule has to hold there.
 *
 * "Unknown" has no field in the contract yet (D359 adds a cost-known flag). These tests accept any
 * recorded form of it — a cost that is not a number, `costKnown: false`, or a truthy
 * `costUnknown` / `unknown` / `priceUnknown` flag on the usage — so the fix chooses the shape.
 */
import type { Model, Provider, Usage } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { newId } from '../../ids.js';
import { sumUsage, usageFor, withReportedCost } from '../cost.js';
import { PROVIDER_ID, createRunDriverHarness, scope } from '../../__tests__/run-driver-harness.js';

const NOW = '2026-10-15T10:00:00.000Z';

function isUnknownCost(usage: Usage): boolean {
  const bag = usage as unknown as Record<string, unknown>;
  return (
    typeof bag['costUsd'] !== 'number' ||
    Number.isNaN(bag['costUsd']) ||
    ['costUnknown', 'unknown', 'priceUnknown'].some((key) => bag[key] === true) ||
    // D359: a cost-known flag on the usage.
    bag['costKnown'] === false
  );
}

/** One Writer run on a provider of this type and URL, whose catalog row is (or is not) priced. */
async function usageOn(type: Provider['type'], baseUrl: string, priced: boolean): Promise<Usage> {
  const h = await createRunDriverHarness();
  const current = await h.repository.providers.get(scope, PROVIDER_ID);
  await h.repository.providers.create(scope, { ...current!, type, baseUrl });
  const row: Model = {
    id: newId(),
    providerId: PROVIDER_ID,
    modelId: 'scripted',
    displayName: 'Scripted',
    inputTypes: ['text'],
    outputTypes: ['text', 'json'],
    contextWindow: 200_000,
    supportsTools: false,
    supportsJson: true,
    available: true,
    source: 'discovered',
    lastCheckedAt: NOW,
    ...(priced
      ? {
          pricing: {
            inputPer1k: 1,
            outputPer1k: 2,
            priceTableVersion: 'pg-v1',
          },
        }
      : {}),
  };
  await h.repository.models.replaceForProvider(scope, PROVIDER_ID, [row]);

  const brief = h.inputNode();
  const writer = h.agentNode('Writer');
  const result = h.outputNode();
  await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
  h.scripts.set('Writer', [{ text: 'done', usage: { tokensIn: 200, tokensOut: 300 } }]);

  const begun = await h.start();
  const ended = await begun.done;
  expect(ended.status).toBe('COMPLETE');
  const [nodeRun] = await h.nodeRunsOf(begun.run.id, writer.id);
  return nodeRun!.usage;
}

describe('PG-1.4 cost: local models are $0 by rule, unpriced remote models are unknown', () => {
  it('an Ollama model is recorded at $0 even when a price row exists', async () => {
    const usage = await usageOn('ollama', 'http://localhost:11434', true);

    expect(usage.costUsd).toBe(0);
    expect(isUnknownCost(usage)).toBe(false);
  });

  it(
    'a LAN openai_compatible model (LM Studio) is recorded at $0 even when priced',
    async () => {
      const usage = await usageOn('openai_compatible', 'http://192.168.1.20:1234/v1', true);

      expect(usage.costUsd).toBe(0);
    },
  );

  it(
    'an unpriced remote openai_compatible model is recorded as unknown, not $0',
    async () => {
      const usage = await usageOn('openai_compatible', 'https://api.together.xyz/v1', false);

      expect(isUnknownCost(usage)).toBe(true);
    },
  );

  it('control: a priced remote model is priced from its row (passes today)', async () => {
    const usage = await usageOn('openai_compatible', 'https://api.together.xyz/v1', true);

    expect(usage.costUsd).toBeGreaterThan(0);
    expect(usage.priceTableVersion).toBe('pg-v1');
    expect(isUnknownCost(usage)).toBe(false);
  });
});

describe('PG-1.4 cost: totals carry an unknown part', () => {
  it('a run total with any unknown part is unknown; known parts still add up', () => {
    const total = sumUsage([
      { tokensIn: 10, tokensOut: 10, costUsd: 0.5 },
      { tokensIn: 5, tokensOut: 5, costUsd: 0, costKnown: false },
    ]);
    expect(total.costKnown).toBe(false);
    expect(total.costUsd).toBe(0.5);
    expect(sumUsage([{ tokensIn: 1, tokensOut: 1, costUsd: 1 }]).costKnown).toBeUndefined();
  });

  it('a cost the provider reported itself is known even when the model is unpriced', () => {
    const priced = usageFor(10, 10, undefined, { type: 'claude_code' });
    expect(priced.costKnown).toBe(false);
    const reported = withReportedCost(priced, 0.02);
    expect(reported.costKnown).toBeUndefined();
    expect(reported.costUsd).toBe(0.02);
  });

  it('the test provider keeps the plain table rule (an unpriced mock model is $0, known)', () => {
    expect(usageFor(10, 10, undefined, { type: 'mock' }).costKnown).toBeUndefined();
  });
});
