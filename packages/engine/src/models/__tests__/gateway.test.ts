import type { Model, NodeError } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { AceNodeError, nodeErrorOf } from '../../errors/index.js';
import {
  LOCAL_SCOPE,
  type ProviderAdapter,
  type RouterModel,
  type StreamChunk,
} from '../../ports/index.js';
import { createSemaphore } from '../../providers/semaphore.js';
import { createModelGateway } from '../gateway.js';

const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const NOW = '2026-10-06T10:00:00.000Z';

const model = (overrides: Partial<Model> = {}): Model => ({
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'sonnet',
  displayName: 'Claude Sonnet',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
  ...overrides,
});

const adapterThat = (generate: ProviderAdapter['generate']): ProviderAdapter => ({
  type: 'claude_code',
  check: async () => ({ status: 'CONNECTED' }),
  listModels: async () => [],
  generate,
});

const request = { modelId: 'sonnet', prompt: 'x', outputTypes: ['text' as const] };

/** A stream whose first read fails with `error`. */
const failingWith = (error: unknown): AsyncIterable<StreamChunk> => ({
  [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
});

async function build(adapter?: ProviderAdapter) {
  let rows: Model[] = [model()];
  const gated: string[] = [];
  let reader: () => readonly RouterModel[] = () => [];
  const gateway = await createModelGateway({
    providers: {
      adapterFor: async () =>
        adapter ?? adapterThat(() => (async function* (): AsyncGenerator<StreamChunk> {})()),
      semaphoreFor: async (id) => {
        gated.push(id);
        return createSemaphore(1);
      },
    },
    models: { list: async () => rows },
    scope: LOCAL_SCOPE,
    createRouter: (catalog) => {
      reader = catalog;
      const refuse = () => ({
        ok: false as const,
        code: 'unavailable_model' as const,
        reason: 'stub',
      });
      return { resolve: refuse, resolveForBench: refuse };
    },
  });
  return {
    gateway,
    gated,
    setRows: (next: Model[]) => {
      rows = next;
    },
    reader: () => reader(),
  };
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('X1 §4.1 the model gateway', () => {
  it('passes a provider’s chunks through untouched', async () => {
    const chunks: StreamChunk[] = [
      { type: 'text', delta: 'hi' },
      { type: 'usage', tokensIn: 1, tokensOut: 1 },
      { type: 'finish', reason: 'stop' },
    ];
    const { gateway } = await build(
      adapterThat(() =>
        (async function* () {
          yield* chunks;
        })(),
      ),
    );
    const adapter = await gateway.adapterFor(PROVIDER_ID);
    expect(await drain(adapter.generate(request, new AbortController().signal))).toEqual(chunks);
  });

  it('names the provider on a classified failure that does not', async () => {
    const declared: NodeError = {
      kind: 'provider',
      code: 'cli_exit_1',
      message: 'boom',
      retryable: false,
    };
    const { gateway } = await build(adapterThat(() => failingWith(new AceNodeError(declared))));
    const adapter = await gateway.adapterFor(PROVIDER_ID);
    const error = await drain(adapter.generate(request, new AbortController().signal)).catch(
      (caught: unknown) => caught,
    );
    expect(nodeErrorOf(error)).toEqual({ ...declared, providerId: PROVIDER_ID });
  });

  it('leaves an unclassified failure for the executor to classify', async () => {
    const raw = new Error('socket hang up');
    const { gateway } = await build(adapterThat(() => failingWith(raw)));
    const adapter = await gateway.adapterFor(PROVIDER_ID);
    await expect(drain(adapter.generate(request, new AbortController().signal))).rejects.toBe(raw);
  });

  it('runs a call inside that provider’s gate', async () => {
    const { gateway, gated } = await build();
    expect(await gateway.runGated(PROVIDER_ID, async () => 42)).toBe(42);
    expect(gated).toEqual([PROVIDER_ID]);
  });

  it('prices from the catalog and lets the router read a refreshed one', async () => {
    const priced = model({
      pricing: { inputPer1k: 0.003, outputPer1k: 0.015, priceTableVersion: 'v1' },
    });
    const { gateway, setRows, reader } = await build();
    expect(gateway.pricingFor(PROVIDER_ID, 'sonnet')).toBeUndefined();
    setRows([priced]);
    await gateway.refreshCatalog();
    expect(gateway.pricingFor(PROVIDER_ID, 'sonnet')).toEqual(priced.pricing);
    expect(gateway.catalog()).toEqual([priced]);
    expect(reader()).toEqual([
      {
        providerId: PROVIDER_ID,
        modelId: 'sonnet',
        available: true,
        inputTypes: ['text'],
        outputTypes: ['text'],
        pricing: priced.pricing,
      },
    ]);
  });
});
