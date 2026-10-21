import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ProviderAdapter, StreamChunk } from '../adapter.js';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createGoogleAdapter } from '../adapters/google.js';
import { createOllamaAdapter, detectOllama, ollamaRoot } from '../adapters/ollama.js';
import { createOpenAiAdapter } from '../adapters/openai.js';
import { createOpenAiCompatibleAdapter, openAiApiRoot } from '../adapters/openai-compatible.js';

/**
 * Recorded HTTP, never the network (CLAUDE.md §2). Every handler below is a shape one of these
 * providers really answers with; anything not handled makes the test fail loudly rather than
 * reaching out.
 */
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const collect = async (iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
};

const LOCAL = 'http://127.0.0.1:11434';

/* -------------------------------------------------------------------------- */
/* check()                                                                     */
/* -------------------------------------------------------------------------- */

describe('TC-PRV-003 a wrong key is reported as AUTH_FAILED', () => {
  it('anthropic', async () => {
    server.use(
      http.get('https://api.anthropic.com/v1/models', () =>
        HttpResponse.json({ error: { message: 'invalid x-api-key' } }, { status: 401 }),
      ),
    );

    const status = await createAnthropicAdapter({ apiKey: 'wrong' }).check();

    expect(status.status).toBe('AUTH_FAILED');
    expect(status.message).toContain('invalid x-api-key');
  });

  it('openai', async () => {
    server.use(
      http.get('https://api.openai.com/v1/models', () =>
        HttpResponse.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 }),
      ),
    );

    expect((await createOpenAiAdapter({ apiKey: 'wrong' }).check()).status).toBe('AUTH_FAILED');
  });

  it('google', async () => {
    server.use(
      http.get('https://generativelanguage.googleapis.com/v1beta/models', () =>
        HttpResponse.json({ error: { message: 'API key not valid' } }, { status: 403 }),
      ),
    );

    expect((await createGoogleAdapter({ apiKey: 'wrong' }).check()).status).toBe('AUTH_FAILED');
  });

  it('audit P-7 google, which refuses a bad key with 400 INVALID_ARGUMENT', async () => {
    server.use(
      http.get('https://generativelanguage.googleapis.com/v1beta/models', () =>
        HttpResponse.json(
          {
            error: {
              code: 400,
              message: 'API key not valid. Please pass a valid API key.',
              status: 'INVALID_ARGUMENT',
              details: [{ reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
            },
          },
          { status: 400 },
        ),
      ),
    );

    const status = await createGoogleAdapter({ apiKey: 'wrong' }).check();

    expect(status.status).toBe('AUTH_FAILED');
    expect(status.message).toContain('API key not valid');
  });
});

describe('TC-PRV-004 a dead endpoint is reported as UNREACHABLE', () => {
  it('openai_compatible against a base URL that refuses the connection', async () => {
    server.use(http.get('http://unreachable.local/v1/models', () => HttpResponse.error()));

    const status = await createOpenAiCompatibleAdapter({
      baseUrl: 'http://unreachable.local',
    }).check();

    expect(status.status).toBe('UNREACHABLE');
  });

  it('ollama when nothing is listening on the local port', async () => {
    server.use(http.get(`${LOCAL}/v1/models`, () => HttpResponse.error()));

    expect((await createOllamaAdapter({ baseUrl: LOCAL }).check()).status).toBe('UNREACHABLE');
  });
});

describe('FR-PRV-003 a rate-limited provider is reported as RATE_LIMITED', () => {
  it('reads the 429 rather than calling it an outage', async () => {
    server.use(
      http.get('https://api.openai.com/v1/models', () =>
        HttpResponse.json({ error: { message: 'slow down' } }, { status: 429 }),
      ),
    );

    expect((await createOpenAiAdapter({ apiKey: 'k' }).check()).status).toBe('RATE_LIMITED');
  });
});

describe('FR-PRV-003 a working provider is CONNECTED with a latency', () => {
  it('anthropic', async () => {
    server.use(
      http.get('https://api.anthropic.com/v1/models', ({ request }) => {
        expect(request.headers.get('x-api-key')).toBe('secret-key');
        expect(request.headers.get('anthropic-version')).toBeTruthy();
        return HttpResponse.json({ data: [{ id: 'claude-sonnet-4-5' }] });
      }),
    );

    const status = await createAnthropicAdapter({ apiKey: 'secret-key' }).check();

    expect(status.status).toBe('CONNECTED');
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('openai sends the key as a bearer token', async () => {
    server.use(
      http.get('https://api.openai.com/v1/models', ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer secret-key');
        return HttpResponse.json({ data: [{ id: 'gpt-4o-mini' }] });
      }),
    );

    expect((await createOpenAiAdapter({ apiKey: 'secret-key' }).check()).status).toBe('CONNECTED');
  });

  it('google sends the key as a query parameter', async () => {
    server.use(
      http.get('https://generativelanguage.googleapis.com/v1beta/models', ({ request }) => {
        expect(new URL(request.url).searchParams.get('key')).toBe('secret-key');
        return HttpResponse.json({ models: [{ name: 'models/gemini-2.5-flash' }] });
      }),
    );

    expect((await createGoogleAdapter({ apiKey: 'secret-key' }).check()).status).toBe('CONNECTED');
  });
});

/* -------------------------------------------------------------------------- */
/* listModels()                                                                */
/* -------------------------------------------------------------------------- */

describe('TC-MOD-001 discovery lists what the provider says it has', () => {
  it('anthropic returns the ids from /v1/models', async () => {
    server.use(
      http.get('https://api.anthropic.com/v1/models', () =>
        HttpResponse.json({
          data: [
            { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
            { id: 'claude-haiku-4-5' },
          ],
        }),
      ),
    );

    const models = await createAnthropicAdapter({ apiKey: 'k' }).listModels();

    expect(models.map((m) => m.modelId)).toEqual(['claude-sonnet-4-5', 'claude-haiku-4-5']);
    expect(models[0]?.displayName).toBe('Claude Sonnet 4.5');
    expect(models[1]?.displayName).toBe('claude-haiku-4-5');
  });

  it('google strips the models/ prefix its API adds', async () => {
    server.use(
      http.get('https://generativelanguage.googleapis.com/v1beta/models', () =>
        HttpResponse.json({
          models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }],
        }),
      ),
    );

    expect((await createGoogleAdapter({ apiKey: 'k' }).listModels())[0]?.modelId).toBe(
      'gemini-2.5-flash',
    );
  });

  it('TC-PRV-007 an OpenAI-compatible server makes its models selectable', async () => {
    server.use(
      http.get('http://localhost:1234/v1/models', () =>
        HttpResponse.json({ data: [{ id: 'qwen2.5-coder' }, { id: 'llama-3.1-8b' }] }),
      ),
    );

    const models = await createOpenAiCompatibleAdapter({
      baseUrl: 'http://localhost:1234',
    }).listModels();

    expect(models.map((m) => m.modelId)).toEqual(['qwen2.5-coder', 'llama-3.1-8b']);
    expect(models[0]?.inputTypes).toEqual(['text']);
    expect(models[0]?.outputTypes).toEqual(['text']);
  });

  it('an OpenAI-compatible server needs no key', async () => {
    server.use(
      http.get('http://localhost:1234/v1/models', ({ request }) => {
        expect(request.headers.get('authorization')).toBeNull();
        return HttpResponse.json({ data: [] });
      }),
    );

    expect(
      await createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:1234' }).listModels(),
    ).toEqual([]);
  });

  it('reports a listing failure as an error rather than an empty catalog', async () => {
    server.use(
      http.get('http://localhost:1234/v1/models', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );

    await expect(
      createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:1234' }).listModels(),
    ).rejects.toMatchObject({ nodeError: { kind: 'provider', retryable: true } });
  });
});

/* -------------------------------------------------------------------------- */
/* FR-PRV-007 Ollama detection                                                 */
/* -------------------------------------------------------------------------- */

describe('TC-PRV-008 Ollama on the default address is detected', () => {
  it('reports detected when the local server answers', async () => {
    server.use(http.get(`${LOCAL}/v1/models`, () => HttpResponse.json({ data: [] })));

    expect(await detectOllama(LOCAL)).toEqual({ baseUrl: LOCAL, detected: true });
  });

  it('reports not detected when nothing answers, without throwing', async () => {
    server.use(http.get(`${LOCAL}/v1/models`, () => HttpResponse.error()));

    expect(await detectOllama(LOCAL)).toEqual({ baseUrl: LOCAL, detected: false });
  });

  it('probes the documented local address by default', async () => {
    let seen = '';
    server.use(
      http.get(`${LOCAL}/v1/models`, ({ request }) => {
        seen = request.url;
        return HttpResponse.json({ data: [] });
      }),
    );

    await detectOllama();
    expect(seen).toContain('127.0.0.1:11434');
  });
});

/* -------------------------------------------------------------------------- */
/* generate() — the shared AI SDK streaming path                               */
/* -------------------------------------------------------------------------- */

/** A real OpenAI chat-completions SSE stream, trimmed to three chunks. `usage: null` sends none. */
function sseStream(
  usage: object | null = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
): HttpResponse<string> {
  const chunk = (delta: object, finish: string | null, usage?: object): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'local-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`;

  const body =
    chunk({ role: 'assistant', content: '' }, null) +
    chunk({ content: 'Hel' }, null) +
    chunk({ content: 'lo' }, null) +
    chunk({}, 'stop', usage ?? undefined) +
    'data: [DONE]\n\n';

  return new HttpResponse(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('FR-EXE-008 the adapter streams text, then usage, then finish', () => {
  it('turns an OpenAI-style SSE stream into StreamChunks', async () => {
    server.use(http.post('http://localhost:1234/v1/chat/completions', () => sseStream()));

    const chunks = await collect(
      createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:1234' }).generate(
        { modelId: 'local-model', prompt: 'say hello', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    );

    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.delta)
      .join('');

    expect(text).toBe('Hello');
    expect(chunks.at(-2)).toEqual({ type: 'usage', tokensIn: 7, tokensOut: 2 });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('a stream that reports no usage yields no usage chunk, so the executor estimates (D313)', async () => {
    server.use(http.post('http://localhost:1234/v1/chat/completions', () => sseStream(null)));
    const chunks = await collect(
      createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:1234' }).generate(
        { modelId: 'local-model', prompt: 'say hello', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    );
    expect(chunks.some((c) => c.type === 'usage')).toBe(false);
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('carries the cached prompt tokens the provider reported (D313)', async () => {
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', () =>
        sseStream({
          prompt_tokens: 7,
          completion_tokens: 2,
          total_tokens: 9,
          prompt_tokens_details: { cached_tokens: 5 },
        }),
      ),
    );
    const chunks = await collect(
      createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:1234' }).generate(
        { modelId: 'local-model', prompt: 'say hello', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    );
    expect(chunks.at(-2)).toEqual({ type: 'usage', tokensIn: 7, tokensOut: 2, cachedTokensIn: 5 });
  });

  it('sends the assembled prompt and the system section separately', async () => {
    let body: { messages?: { role: string; content: unknown }[] } = {};
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return sseStream();
      }),
    );

    await collect(
      createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:1234' }).generate(
        {
          modelId: 'local-model',
          system: 'You are ACE.',
          prompt: '## Input\nsay hello',
          outputTypes: ['text'],
        },
        new AbortController().signal,
      ),
    );

    expect(body.messages?.[0]).toMatchObject({ role: 'system', content: 'You are ACE.' });
    expect(JSON.stringify(body.messages?.[1])).toContain('say hello');
  });

  it('maps a mid-call provider failure to a retryable provider error', async () => {
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', () =>
        HttpResponse.json({ error: { message: 'overloaded' } }, { status: 503 }),
      ),
    );

    await expect(
      collect(
        createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:1234' }).generate(
          { modelId: 'local-model', prompt: 'x', outputTypes: ['text'] },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ nodeError: { kind: 'provider', retryable: true } });
  });

  it('maps a 401 to an auth error that is never retried', async () => {
    server.use(
      http.post('http://localhost:1234/v1/chat/completions', () =>
        HttpResponse.json({ error: { message: 'bad key' } }, { status: 401 }),
      ),
    );

    await expect(
      collect(
        createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:1234', apiKey: 'k' }).generate(
          { modelId: 'local-model', prompt: 'x', outputTypes: ['text'] },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ nodeError: { kind: 'auth', retryable: false } });
  });
});

/** The engine port's `embed` takes the model in an options bag; this keeps the call typed. */
type Embed = (texts: string[], options?: { modelId?: string }) => Promise<number[][]>;
const embedOf = (adapter: ProviderAdapter): Embed => {
  if (adapter.embed === undefined) throw new Error('adapter has no embed');
  return adapter.embed.bind(adapter) as Embed;
};

/* -------------------------------------------------------------------------- */
/* embed() (FR-RAG-004)                                                        */
/* -------------------------------------------------------------------------- */

describe('FR-RAG-004 embed() posts the batch and parses the vectors', () => {
  const texts = ['alpha', 'beta'];
  const unit = [
    [1, 0],
    [0, 1],
  ];

  it('ollama: POST /api/embed with { model, input }', async () => {
    let seen: unknown;
    server.use(
      http.post(`${LOCAL}/api/embed`, async ({ request }) => {
        seen = await request.json();
        return HttpResponse.json({ embeddings: unit });
      }),
    );

    const vectors = await embedOf(createOllamaAdapter())(texts, { modelId: 'nomic-embed-text' });

    expect(seen).toEqual({ model: 'nomic-embed-text', input: texts });
    expect(vectors).toEqual(unit);
  });

  it('openai: POST /v1/embeddings with the key, ordered by index', async () => {
    let seen: unknown;
    let auth: string | null = null;
    server.use(
      http.post('https://api.openai.com/v1/embeddings', async ({ request }) => {
        seen = await request.json();
        auth = request.headers.get('authorization');
        return HttpResponse.json({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        });
      }),
    );

    const vectors = await embedOf(createOpenAiAdapter({ apiKey: 'sk-test' }))(texts, {
      modelId: 'text-embedding-3-small',
    });

    expect(seen).toEqual({ model: 'text-embedding-3-small', input: texts });
    expect(auth).toBe('Bearer sk-test');
    expect(vectors).toEqual(unit);
  });

  it('openai_compatible: POST {baseUrl}/v1/embeddings, no key header when none is set', async () => {
    let auth: string | null = 'unset';
    server.use(
      http.post('http://gateway.local/v1/embeddings', async ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 1, embedding: [0, 1] },
          ],
        });
      }),
    );

    const vectors = await embedOf(
      createOpenAiCompatibleAdapter({
        baseUrl: 'http://gateway.local/',
      }),
    )(texts, { modelId: 'bge' });

    expect(auth).toBeNull();
    expect(vectors).toEqual(unit);
  });

  it('google: POST :batchEmbedContents with one request per text', async () => {
    let seen: unknown;
    let key: string | null = null;
    server.use(
      http.post(
        'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004\\:batchEmbedContents',
        async ({ request }) => {
          seen = await request.json();
          key = request.headers.get('x-goog-api-key');
          return HttpResponse.json({ embeddings: [{ values: [1, 0] }, { values: [0, 1] }] });
        },
      ),
    );

    const vectors = await embedOf(createGoogleAdapter({ apiKey: 'g-key' }))(texts, {
      modelId: 'text-embedding-004',
    });

    expect(seen).toEqual({
      requests: [
        { model: 'models/text-embedding-004', content: { parts: [{ text: 'alpha' }] } },
        { model: 'models/text-embedding-004', content: { parts: [{ text: 'beta' }] } },
      ],
    });
    expect(key).toBe('g-key');
    expect(vectors).toEqual(unit);
  });

  it('anthropic has no embed', () => {
    expect(createAnthropicAdapter({ apiKey: 'k' }).embed).toBeUndefined();
  });

  it('a call without a model id is a programming error', async () => {
    await expect(embedOf(createOllamaAdapter())(texts)).rejects.toThrow(/modelId/);
    await expect(embedOf(createOpenAiAdapter({ apiKey: 'k' }))(texts, {})).rejects.toThrow(
      /modelId/,
    );
    await expect(embedOf(createGoogleAdapter({ apiKey: 'k' }))(texts)).rejects.toThrow(/modelId/);
  });

  it('an empty batch makes no request', async () => {
    expect(await embedOf(createOllamaAdapter())([], { modelId: 'm' })).toEqual([]);
  });
});

describe('FR-RAG-004 embed() failures are classified like generate()', () => {
  const failing = (url: string, status: number): void => {
    server.use(http.post(url, () => HttpResponse.json({ error: { message: 'no' } }, { status })));
  };

  it('401 is auth on openai', async () => {
    failing('https://api.openai.com/v1/embeddings', 401);
    await expect(
      embedOf(createOpenAiAdapter({ apiKey: 'bad' }))(['a'], { modelId: 'm' }),
    ).rejects.toMatchObject({ nodeError: { kind: 'auth' } });
  });

  it('429 and 503 are retryable provider errors', async () => {
    failing(`${LOCAL}/api/embed`, 429);
    await expect(embedOf(createOllamaAdapter())(['a'], { modelId: 'm' })).rejects.toMatchObject({
      nodeError: { kind: 'provider', code: 'http_429', retryable: true },
    });
    failing('https://generativelanguage.googleapis.com/v1beta/models/m\\:batchEmbedContents', 503);
    await expect(
      embedOf(createGoogleAdapter({ apiKey: 'k' }))(['a'], { modelId: 'm' }),
    ).rejects.toMatchObject({ nodeError: { kind: 'provider', retryable: true } });
  });

  it('a refused connection is a network error', async () => {
    server.use(http.post('http://down.local/v1/embeddings', () => HttpResponse.error()));
    await expect(
      embedOf(createOpenAiCompatibleAdapter({ baseUrl: 'http://down.local' }))(['a'], {
        modelId: 'm',
      }),
    ).rejects.toMatchObject({ nodeError: { kind: 'network' } });
  });

  it('a malformed answer is a non-retryable provider error', async () => {
    server.use(http.post(`${LOCAL}/api/embed`, () => HttpResponse.json({ embeddings: [[1]] })));
    await expect(
      embedOf(createOllamaAdapter())(['a', 'b'], { modelId: 'm' }),
    ).rejects.toMatchObject({ nodeError: { code: 'bad_embedding_response', retryable: false } });
  });
});

/* -------------------------------------------------------------------------- */
/* audit P-4 a base URL that already names its API version                     */
/* -------------------------------------------------------------------------- */

describe('audit P-4 a base URL that already ends in /v1 is the API root', () => {
  it.each([
    ['http://localhost:1234', 'http://localhost:1234/v1'],
    ['http://localhost:1234/', 'http://localhost:1234/v1'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1'],
    ['http://localhost:1234/v1/', 'http://localhost:1234/v1'],
    ['https://gateway.local/v2', 'https://gateway.local/v2'],
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1'],
    ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1'],
    [
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'https://generativelanguage.googleapis.com/v1beta/openai',
    ],
  ])('reads %s as %s', (pasted, root) => {
    expect(openAiApiRoot(pasted)).toBe(root);
  });

  it('lists and chats under a pasted …/v1 without doubling it', async () => {
    server.use(
      http.get('http://localhost:1234/v1/models', () =>
        HttpResponse.json({ data: [{ id: 'local-model' }] }),
      ),
      http.post('http://localhost:1234/v1/chat/completions', () => sseStream()),
    );
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'http://localhost:1234/v1/' });

    expect((await adapter.check()).status).toBe('CONNECTED');
    expect((await adapter.listModels()).map((m) => m.modelId)).toEqual(['local-model']);
    const chunks = await collect(
      adapter.generate(
        { modelId: 'local-model', prompt: 'hi', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    );
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('embeds under a gateway root such as /api/v1', async () => {
    server.use(
      http.post('https://router.local/api/v1/embeddings', () =>
        HttpResponse.json({ data: [{ index: 0, embedding: [1, 0] }] }),
      ),
    );
    const adapter = createOpenAiCompatibleAdapter({ baseUrl: 'https://router.local/api/v1' });

    expect(await embedOf(adapter)(['a'], { modelId: 'bge' })).toEqual([[1, 0]]);
  });

  it('ollama: a pasted …/v1 still reaches the native /api routes beside it', async () => {
    server.use(
      http.get(`${LOCAL}/v1/models`, () => HttpResponse.json({ data: [{ id: 'llama3.2' }] })),
      http.get(`${LOCAL}/api/tags`, () =>
        HttpResponse.json({ models: [{ name: 'llama3.2', size: 2_000_000_000 }] }),
      ),
      http.post(`${LOCAL}/api/show`, () =>
        HttpResponse.json({ capabilities: ['completion', 'tools'] }),
      ),
    );

    const [model] = await createOllamaAdapter({ baseUrl: `${LOCAL}/v1` }).listModels();

    expect(ollamaRoot(`${LOCAL}/v1/`)).toBe(LOCAL);
    expect(model).toMatchObject({
      modelId: 'llama3.2',
      sizeBytes: 2_000_000_000,
      supportsTools: true,
    });
  });
});
