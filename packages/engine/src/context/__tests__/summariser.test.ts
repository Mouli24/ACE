import type { GenerateRequest, ProviderAdapter, StreamChunk } from '../../ports/index.js';
import type { ModelPricing, Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { createTruncatingSummariser, estimatePartsTokens } from '../../envelopes/index.js';
import { LOCAL_SCOPE, SUMMARY_PROMPT_VERSION } from '../../ports/index.js';
import { createModelSummariser, summaryCacheKey } from '../summariser.js';

const PROVIDER = '01JBXQ8Z9KQ4R7N2VWXYZ0PRV1';
const TARGET = { providerId: PROVIDER, modelId: 'mock-summary' };
const KEY_SHAPED = ['sk', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('-');

const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const text = (value: string): Part => ({ type: 'text', text: value });
const reference: Part = {
  type: 'image',
  artifactId: '01JBXQ8Z9KQ4R7N2VWXYZ0ARTF',
  name: 'a.png',
  size: 10,
  mime: 'image/png',
} as Part;

interface Setup {
  requests: GenerateRequest[];
  signals: AbortSignal[];
  cache: FakeRepository['summaryCache'];
  summariser: ReturnType<typeof createModelSummariser>;
  reasons: string[];
}

function setup(
  options: {
    reply?: (req: GenerateRequest) => StreamChunk[];
    adapterError?: boolean;
    pricing?: ModelPricing;
    putFails?: boolean;
    stream?: ProviderAdapter['generate'];
  } = {},
): Setup {
  const requests: GenerateRequest[] = [];
  const signals: AbortSignal[] = [];
  const repository = new FakeRepository();
  const reply =
    options.reply ??
    ((req: GenerateRequest): StreamChunk[] => [
      { type: 'text', delta: req.prompt.split(/\s+/).slice(0, 30).join(' ') },
      { type: 'usage', tokensIn: 1000, tokensOut: 40 },
      { type: 'finish', reason: 'stop' },
    ]);
  const reasons: string[] = [];
  const adapter: ProviderAdapter = {
    type: 'mock',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
    generate:
      options.stream ??
      async function* (req, signal) {
        requests.push(req);
        signals.push(signal);
        yield* reply(req);
      },
  };
  const summariser = createModelSummariser({
    adapterFor: async () => {
      if (options.adapterError === true) throw new Error('no adapter');
      return adapter;
    },
    runGated: (_providerId, fn) => fn(),
    cache:
      options.putFails === true
        ? {
            get: repository.summaryCache.get,
            put: async () => {
              throw new Error('cache down');
            },
          }
        : repository.summaryCache,
    onFallback: (reason) => reasons.push(reason),
    scope: LOCAL_SCOPE,
    now: () => '2026-10-01T00:00:00.000Z',
    fallback: createTruncatingSummariser(),
    pricingFor: async () => options.pricing,
  });
  return { requests, signals, cache: repository.summaryCache, summariser, reasons };
}

const summaryCalls = (s: Setup): GenerateRequest[] =>
  s.requests.filter((r) => r.system?.includes(SUMMARY_PROMPT_VERSION));

describe('model summariser', () => {
  it('leaves content under budget unchanged, with no call', async () => {
    const s = setup();
    const out = await s.summariser.summarise({
      parts: [text('short')],
      budgetTokens: 100,
      target: TARGET,
    });
    expect(out.parts).toEqual([text('short')]);
    expect(out.summary).toBeUndefined();
    expect(s.requests).toHaveLength(0);
  });

  it('summarises over-budget content with one text part, references kept whole, and a priced usage', async () => {
    const s = setup({
      pricing: { inputPer1k: 1, outputPer1k: 2, priceTableVersion: 'pt1' } as ModelPricing,
    });
    const parts = [text(words(2000)), reference];
    const out = await s.summariser.summarise({ parts, budgetTokens: 200, target: TARGET });
    expect(out.parts).toHaveLength(2);
    expect(out.parts[0]).toMatchObject({ type: 'text' });
    expect(out.parts[1]).toEqual(reference);
    expect(out.summary).toBe('summarised by mock-summary');
    expect(estimatePartsTokens(out.parts)).toBeLessThanOrEqual(200);
    expect(summaryCalls(s)).toHaveLength(1);
    // TC-RAG-010 (usage returned): 1000 in at 1/1k + 40 out at 2/1k.
    expect(out.usage).toEqual({
      tokensIn: 1000,
      tokensOut: 40,
      costUsd: 1 + 0.08,
      priceTableVersion: 'pt1',
    });
  });

  it("the summary's usage is returned, unpriced when the model has no price", async () => {
    const s = setup();
    const out = await s.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 200,
      target: TARGET,
    });
    expect(out.usage).toMatchObject({ tokensIn: 1000, tokensOut: 40, costUsd: 0 });
  });

  it('TC-RAG-009 two identical over-budget envelopes → exactly one summarisation call', async () => {
    const s = setup();
    const input = { parts: [text(words(2000))], budgetTokens: 200, target: TARGET };
    const first = await s.summariser.summarise(input);
    const second = await s.summariser.summarise(input);
    expect(summaryCalls(s)).toHaveLength(1);
    expect(second.parts).toEqual(first.parts);
    expect(second.summary).toBe(first.summary);
    expect(second.usage).toBeUndefined();
  });

  it('a cache hit makes no provider call', async () => {
    const s = setup();
    const body = words(2000);
    const key = summaryCacheKey(body, 200, 'mock-summary');
    await s.cache.put(LOCAL_SCOPE, key, 'cached summary', '2026-10-01T00:00:00.000Z');
    const out = await s.summariser.summarise({
      parts: [text(body)],
      budgetTokens: 200,
      target: TARGET,
    });
    expect(s.requests).toHaveLength(0);
    expect(out.parts).toEqual([text('cached summary')]);
  });

  it('the cache key varies with text, size and model', () => {
    const base = summaryCacheKey('a', 10, 'm');
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(summaryCacheKey('b', 10, 'm')).not.toBe(base);
    expect(summaryCacheKey('a', 11, 'm')).not.toBe(base);
    expect(summaryCacheKey('a', 10, 'n')).not.toBe(base);
    expect(summaryCacheKey('a', 10, 'm')).toBe(base);
  });

  it('a provider failure falls back to truncation', async () => {
    const s = setup({
      reply: () => [{ type: 'finish', reason: 'error' }],
    });
    const out = await s.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 200,
      target: TARGET,
    });
    expect(out.summary).toBe('truncated to budget');
    expect(estimatePartsTokens(out.parts)).toBeLessThanOrEqual(200);
    expect(out.usage).toBeUndefined();
  });

  it('a thrown provider error and an adapter error both fall back', async () => {
    const throwing = setup({
      reply: () => {
        throw new Error('boom');
      },
    });
    const a = await throwing.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 200,
      target: TARGET,
    });
    expect(a.summary).toBe('truncated to budget');

    const noAdapter = setup({ adapterError: true });
    const b = await noAdapter.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 200,
      target: TARGET,
    });
    expect(b.summary).toBe('truncated to budget');
  });

  it('no target falls back to truncation; so does a budget the references already use up', async () => {
    const s = setup();
    const a = await s.summariser.summarise({ parts: [text(words(2000))], budgetTokens: 200 });
    expect(a.summary).toBe('truncated to budget');
    const b = await s.summariser.summarise({
      parts: [text(words(2000)), reference],
      budgetTokens: 1,
      target: TARGET,
    });
    expect(b.summary).toBe('truncated to budget');
    const c = await s.summariser.summarise({
      parts: [reference, reference],
      budgetTokens: 1,
      target: TARGET,
    });
    expect(c.summary).toBe('truncated to budget');
    expect(s.requests).toHaveLength(0);
  });

  it('an already-aborted signal makes no call; a live one is passed to the provider', async () => {
    const s = setup();
    const controller = new AbortController();
    await s.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 200,
      target: TARGET,
      signal: controller.signal,
    });
    expect(s.signals[0]).toBe(controller.signal);

    const aborted = setup();
    const gone = new AbortController();
    gone.abort();
    const out = await aborted.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 200,
      target: TARGET,
      signal: gone.signal,
    });
    expect(aborted.requests).toHaveLength(0);
    expect(out.summary).toBe('truncated to budget');
  });

  it('clamps an over-long summary to the budget', async () => {
    const s = setup({
      reply: () => [
        { type: 'text', delta: 'x'.repeat(5000) },
        { type: 'finish', reason: 'stop' },
      ],
    });
    const out = await s.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 100,
      target: TARGET,
    });
    expect(estimatePartsTokens(out.parts)).toBeLessThanOrEqual(100);
  });

  it('a summary containing a key-shaped string is cached and returned masked (D86)', async () => {
    const s = setup({
      reply: () => [
        { type: 'text', delta: `use ${KEY_SHAPED} now` },
        { type: 'finish', reason: 'stop' },
      ],
    });
    const body = words(2000);
    const out = await s.summariser.summarise({
      parts: [text(body)],
      budgetTokens: 200,
      target: TARGET,
    });
    const rendered = JSON.stringify(out.parts);
    expect(rendered).not.toContain(KEY_SHAPED);
    const cached = await s.cache.get(
      LOCAL_SCOPE,
      summaryCacheKey(body, 200, 'mock-summary'),
      '2026-10-01T00:00:00.000Z',
    );
    expect(cached).not.toContain(KEY_SHAPED);
    expect(cached).toContain('[REDACTED]');
  });

  it('sends the prompt-version marker in the system text', async () => {
    const s = setup();
    await s.summariser.summarise({ parts: [text(words(2000))], budgetTokens: 200, target: TARGET });
    expect(s.requests[0]!.system).toContain(SUMMARY_PROMPT_VERSION);
    expect(s.requests[0]!.system).toContain('at most 200 tokens');
  });

  it('reports a provider failure through onFallback, without the prompt or a secret', async () => {
    const s = setup({
      reply: () => {
        throw Object.assign(new Error(`bad key ${KEY_SHAPED}`), {
          nodeError: { kind: 'auth', code: 'unauthorized' },
        });
      },
    });
    const out = await s.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 200,
      target: TARGET,
    });
    expect(out.summary).toBe('truncated to budget');
    expect(s.reasons).toHaveLength(1);
    expect(s.reasons[0]).toContain('mock-summary');
    expect(s.reasons[0]).toContain('unauthorized');
    expect(s.reasons[0]).not.toContain(KEY_SHAPED);
    expect(s.reasons[0]).not.toContain('word1');
  });

  it.each([
    [
      'a classified error with no kind or code',
      () => Object.assign(new Error('x'), { nodeError: {} }),
    ],
    ['an Error with an empty name', () => Object.assign(new Error('x'), { name: '' })],
    ['a thrown string', () => 'nope'],
  ])('FR-RAG-010 never reports an empty reason: %s reads as unknown', async (_label, thrown) => {
    const s = setup({
      reply: () => {
        throw thrown();
      },
    });
    await s.summariser.summarise({ parts: [text(words(2000))], budgetTokens: 200, target: TARGET });
    expect(s.reasons).toHaveLength(1);
    expect(s.reasons[0]).toContain('model summary failed (unknown) for mock-summary');
  });

  it('a mid-call abort falls back without calling onFallback', async () => {
    const controller = new AbortController();
    const s = setup({
      stream: async function* (_req, signal) {
        controller.abort();
        await new Promise<void>((_, reject) => {
          if (signal.aborted) reject(new Error('aborted'));
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        yield { type: 'finish', reason: 'stop' };
      },
    });
    const out = await s.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 200,
      target: TARGET,
      signal: controller.signal,
    });
    expect(out.summary).toBe('truncated to budget');
    expect(s.reasons).toEqual([]);
  });

  it('a cache.put failure still returns the summary and usage, without onFallback', async () => {
    const s = setup({ putFails: true });
    const out = await s.summariser.summarise({
      parts: [text(words(2000))],
      budgetTokens: 200,
      target: TARGET,
    });
    expect(out.summary).toBe('summarised by mock-summary');
    expect(out.usage).toMatchObject({ tokensIn: 1000 });
    expect(s.reasons).toEqual([]);
  });
});
