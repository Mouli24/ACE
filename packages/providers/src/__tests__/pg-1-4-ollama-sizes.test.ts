import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createOllamaAdapter } from '../adapters/ollama.js';
import { mergeCatalog } from '../catalog/index.js';

/**
 * PG-1.4 (D359): the Local & open section shows each model's size on disk, read from Ollama's
 * native `/api/tags` list. Recorded HTTP only.
 */
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const LOCAL = 'http://127.0.0.1:11434';

describe('PG-1.4 Ollama discovery fills sizeBytes from /api/tags', () => {
  it('each listed model carries the size its tag reports', async () => {
    server.use(
      http.get(`${LOCAL}/v1/models`, () =>
        HttpResponse.json({
          object: 'list',
          data: [
            { id: 'llama3.2:1b', object: 'model' },
            { id: 'qwen2.5:0.5b', object: 'model' },
          ],
        }),
      ),
      http.get(`${LOCAL}/api/tags`, () =>
        HttpResponse.json({
          models: [
            { name: 'llama3.2:1b', model: 'llama3.2:1b', size: 1_321_098_329 },
            { name: 'broken', size: 'big' },
          ],
        }),
      ),
    );

    const models = await createOllamaAdapter({ baseUrl: LOCAL }).listModels();

    expect(models.find((m) => m.modelId === 'llama3.2:1b')?.sizeBytes).toBe(1_321_098_329);
    expect(models.find((m) => m.modelId === 'qwen2.5:0.5b')?.sizeBytes).toBeUndefined();
  });

  it('a service without /api/tags still lists its models, with no size', async () => {
    server.use(
      http.get(`${LOCAL}/v1/models`, () =>
        HttpResponse.json({ object: 'list', data: [{ id: 'llama3.2', object: 'model' }] }),
      ),
      http.get(`${LOCAL}/api/tags`, () => new HttpResponse(null, { status: 404 })),
    );

    const models = await createOllamaAdapter({ baseUrl: LOCAL }).listModels();

    expect(models.map((m) => m.modelId)).toEqual(['llama3.2']);
    expect(models[0]?.sizeBytes).toBeUndefined();
  });

  it('the catalog merge keeps the discovered size over a manifest entry', () => {
    const merged = mergeCatalog(
      [
        {
          modelId: 'llama3.2',
          displayName: 'llama3.2',
          inputTypes: ['text'],
          outputTypes: ['text'],
          contextWindow: 8192,
          supportsTools: false,
          supportsJson: false,
          sizeBytes: 2_000_000_000,
        },
      ],
      [
        {
          modelId: 'llama3.2',
          displayName: 'Llama 3.2',
          inputTypes: ['text'],
          outputTypes: ['text', 'json'],
          contextWindow: 131_072,
          supportsTools: true,
          supportsJson: true,
          pricing: { inputPer1k: 0, outputPer1k: 0, priceTableVersion: 'local' },
        },
      ],
    );

    expect(merged[0]).toMatchObject({ sizeBytes: 2_000_000_000, supportsTools: true });
  });
});
