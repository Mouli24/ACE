import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createOllamaAdapter } from '../adapters/ollama.js';

/** Agentic nodes P2 (Task 4): a local model's real context window, read from `/api/show`. */
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const LOCAL = 'http://127.0.0.1:11434';

describe('Ollama discovery reads the context window from /api/show', () => {
  it('model_info "<arch>.context_length" becomes contextWindow', async () => {
    server.use(
      http.get(`${LOCAL}/v1/models`, () =>
        HttpResponse.json({
          object: 'list',
          data: [
            { id: 'llama3.2', object: 'model' },
            { id: 'odd', object: 'model' },
          ],
        }),
      ),
      http.get(`${LOCAL}/api/tags`, () => HttpResponse.json({ models: [] })),
      http.post(`${LOCAL}/api/show`, async ({ request }) => {
        const { model } = (await request.json()) as { model: string };
        return HttpResponse.json(
          model === 'llama3.2'
            ? {
                capabilities: ['completion', 'tools'],
                model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072 },
              }
            : { capabilities: ['completion'], model_info: { 'odd.context_length': 'big' } },
        );
      }),
    );

    const models = await createOllamaAdapter({ baseUrl: LOCAL }).listModels();

    expect(models.find((m) => m.modelId === 'llama3.2')?.contextWindow).toBe(131072);
    // a malformed value leaves the catalogue default standing
    expect(models.find((m) => m.modelId === 'odd')?.contextWindow).toBe(8192);
  });
});
