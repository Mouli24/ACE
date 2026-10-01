import { describe, expect, it } from 'vitest';

import { createEmbedder } from '../index.js';

function fakeAdapter(): {
  adapter: { embed: (texts: string[], options?: { modelId?: string }) => Promise<number[][]> };
  batches: number[];
  options: (string | undefined)[];
} {
  const batches: number[] = [];
  const options: (string | undefined)[] = [];
  return {
    batches,
    options,
    adapter: {
      embed: (texts, opts) => {
        batches.push(texts.length);
        options.push(opts?.modelId);
        return Promise.resolve(texts.map((t) => [Number(t.slice(1))]));
      },
    },
  };
}

const texts = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`);

describe('FR-RAG-002 Embedder', () => {
  it('batches 32 at a time and keeps order', async () => {
    const { adapter, batches } = fakeAdapter();
    const input = texts(70);
    const vectors = await createEmbedder(adapter, 'mock-embed').embed(input);
    expect(batches).toEqual([32, 32, 6]);
    expect(vectors).toEqual(input.map((_, i) => [i]));
  });

  it('honours a custom batch size and makes no call for no texts', async () => {
    const { adapter, batches } = fakeAdapter();
    const embedder = createEmbedder(adapter, 'mock-embed', 4);
    expect(await embedder.embed([])).toEqual([]);
    expect(batches).toEqual([]);
    await embedder.embed(texts(9));
    expect(batches).toEqual([4, 4, 1]);
  });

  it('passes the KB model id', async () => {
    const { adapter, options } = fakeAdapter();
    await createEmbedder(adapter, 'mock-embed').embed(texts(2));
    expect(options).toEqual(['mock-embed']);
  });

  it('an adapter without embed() fails with a clear reason', async () => {
    await expect(createEmbedder({}, 'mock-embed').embed(['a'])).rejects.toThrow(
      /cannot create embeddings.*mock-embed/,
    );
  });

  it('rejects when the model returns the wrong number of vectors', async () => {
    const adapter = { embed: () => Promise.resolve([[1]]) };
    await expect(createEmbedder(adapter, 'mock-embed').embed(['a', 'b'])).rejects.toThrow(
      /returned 1 vectors for 2 texts/,
    );
  });
});
