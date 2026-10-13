import { PartSchema, ReviewContractSchema } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import type { GenerateRequest, StreamChunk, ToolResult } from '../adapter.js';
import type { Part } from '@ace/contracts';
import {
  MOCK_MODELS,
  MOCK_PRICE_TABLE_VERSION,
  createMockAdapter,
  formatArtifactReference,
} from '../adapters/mock.js';
import { MOCK_MEDIA_TYPES, mockMediaFixture } from '../adapters/mock-media.js';

/** Drain a generate() call into the chunks it produced. */
async function collect(
  iterable: AsyncIterable<StreamChunk>,
  signal?: AbortSignal,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  if (signal?.aborted === true) chunks.push({ type: 'finish', reason: 'error' });
  return chunks;
}

const textOf = (chunks: StreamChunk[]): string =>
  chunks
    .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
    .map((c) => c.delta)
    .join('');

const jsonOf = (chunks: StreamChunk[]): unknown =>
  chunks.find((c): c is Extract<StreamChunk, { type: 'json' }> => c.type === 'json')?.value;

const usageOf = (chunks: StreamChunk[]) =>
  chunks.find((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage');

const finishOf = (chunks: StreamChunk[]) =>
  chunks.find((c): c is Extract<StreamChunk, { type: 'finish' }> => c.type === 'finish');

const toolCallsOf = (chunks: StreamChunk[]): Extract<StreamChunk, { type: 'tool_call' }>[] =>
  chunks.filter((c): c is Extract<StreamChunk, { type: 'tool_call' }> => c.type === 'tool_call');

const partsOf = (chunks: StreamChunk[]): Part[] =>
  chunks
    .filter((c): c is Extract<StreamChunk, { type: 'part' }> => c.type === 'part')
    .map((c) => c.part);

/** Every test uses the instant clock; the §2.6 delays are asserted separately. */
const adapter = (options: Parameters<typeof createMockAdapter>[0] = {}) =>
  createMockAdapter({ sleep: async () => {}, ...options });

const run = (modelId: string, prompt = 'summarise the brief', extra: Partial<GenerateRequest> = {}) =>
  adapter().generate({ modelId, prompt, outputTypes: ['text'], ...extra }, new AbortController().signal);

/** A tool result to feed back into a continuation turn. */
const toolResult = (name: string, result: unknown): ToolResult => ({ callId: 'ignored', name, result });

/* -------------------------------------------------------------------------- */
/* Provider-level behaviour                                                    */
/* -------------------------------------------------------------------------- */

describe('TC-PRV-010 the mock provider is available for development and tests', () => {
  it('declares itself as the mock type', () => {
    expect(adapter().type).toBe('mock');
  });

  it('reports CONNECTED with a latency when nothing is wrong', async () => {
    const status = await adapter().check();

    expect(status.status).toBe('CONNECTED');
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('answers a check well inside the 50 ms §2.6 allows', async () => {
    const started = Date.now();
    await createMockAdapter().check();

    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe('TC-PRV-003 / TC-PRV-004 the mock simulates every provider failure', () => {
  it('reports AUTH_FAILED for the key "bad"', async () => {
    const status = await adapter({ apiKey: 'bad' }).check();

    expect(status.status).toBe('AUTH_FAILED');
    expect(status.message).toBeTruthy();
  });

  it('reports RATE_LIMITED for the key "ratelimited"', async () => {
    expect((await adapter({ apiKey: 'ratelimited' }).check()).status).toBe('RATE_LIMITED');
  });

  it('reports UNREACHABLE for a baseUrl containing "unreachable"', async () => {
    expect((await adapter({ baseUrl: 'http://unreachable.local' }).check()).status).toBe(
      'UNREACHABLE',
    );
  });

  it('reports CONNECTED for any other key', async () => {
    expect((await adapter({ apiKey: 'anything-else' }).check()).status).toBe('CONNECTED');
  });
});

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

describe('TC-MOD-001 the mock lists every model of §2.6', () => {
  it('lists exactly the models §2.6 tabulates, in that order (round 4 additions included)', async () => {
    const models = await adapter().listModels();

    expect(models.map((m) => m.modelId)).toEqual([
      'mock-text',
      'mock-slow',
      'mock-json',
      'mock-bad-json',
      'mock-503',
      'mock-429-then-ok',
      'mock-401',
      'mock-timeout',
      'mock-refuse',
      'mock-leak',
      'mock-repeat',
      'mock-reject-twice',
      'mock-reject-always',
      'mock-tool',
      'mock-tool-loop',
      'mock-destructive',
      'mock-http',
      'mock-search',
      'mock-mcp',
      'mock-sandbox',
      'mock-vision',
      'mock-media',
      'mock-chat',
      'mock-embed',
      'mock-cite',
      'mock-memory',
      'mock-summary',
      // D315: Domain's scriptable model.
      'mock-script',
    ]);
  });

  it('gives every model the §2.6 price table version', async () => {
    const models = await adapter().listModels();

    for (const model of models) {
      expect(model.pricing?.inputPer1k, model.modelId).toBe(0.001);
      expect(model.pricing?.outputPer1k, model.modelId).toBe(0.002);
      expect(model.pricing?.priceTableVersion, model.modelId).toBe(MOCK_PRICE_TABLE_VERSION);
    }
    expect(MOCK_PRICE_TABLE_VERSION).toBe('mock-v1');
  });

  it('declares the data types §2.6 gives each model', async () => {
    const models = new Map((await adapter().listModels()).map((m) => [m.modelId, m]));

    expect(models.get('mock-text')?.inputTypes).toEqual(['text']);
    expect(models.get('mock-text')?.outputTypes).toEqual(['text']);
    expect(models.get('mock-json')?.inputTypes).toEqual(['text', 'json']);
    expect(models.get('mock-json')?.outputTypes).toEqual(['json']);
    expect(models.get('mock-vision')?.inputTypes).toEqual(['text', 'image']);
    expect(models.get('mock-vision')?.outputTypes).toEqual(['text']);
    expect(models.get('mock-reject-twice')?.inputTypes).toEqual(['text', 'json']);
  });

  it('keeps MOCK_MODELS and listModels() in step', async () => {
    expect((await adapter().listModels()).map((m) => m.modelId)).toEqual(
      MOCK_MODELS.map((m) => m.modelId),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Generation                                                                  */
/* -------------------------------------------------------------------------- */

describe('FR-PRV-010 mock-text streams a deterministic answer', () => {
  it('streams forty words derived from the input', async () => {
    const words = textOf(await collect(run('mock-text'))).trim().split(/\s+/);

    expect(words).toHaveLength(40);
  });

  it('gives the same output for the same input, every time', async () => {
    const first = textOf(await collect(run('mock-text', 'the same brief')));
    const second = textOf(await collect(run('mock-text', 'the same brief')));

    expect(first).toBe(second);
  });

  it('gives a different output for a different input', async () => {
    const first = textOf(await collect(run('mock-text', 'brief one')));
    const second = textOf(await collect(run('mock-text', 'brief two')));

    expect(first).not.toBe(second);
  });

  it('finishes with reason stop', async () => {
    expect(finishOf(await collect(run('mock-text')))?.reason).toBe('stop');
  });

  it('counts tokens as whitespace-separated words', async () => {
    const chunks = await collect(run('mock-text', 'four words in total'));
    const usage = usageOf(chunks);

    expect(usage?.tokensIn).toBe(4);
    expect(usage?.tokensOut).toBe(40);
  });

  it('emits usage before finish, so a consumer can bill what it just read', async () => {
    const chunks = await collect(run('mock-text'));
    const usageAt = chunks.findIndex((c) => c.type === 'usage');
    const finishAt = chunks.findIndex((c) => c.type === 'finish');

    expect(usageAt).toBeGreaterThan(-1);
    expect(usageAt).toBeLessThan(finishAt);
  });
});

describe('FR-PRV-010 mock-slow streams a hundred words for the stream tests', () => {
  it('streams a hundred words', async () => {
    const words = textOf(await collect(run('mock-slow'))).trim().split(/\s+/);

    expect(words).toHaveLength(100);
  });

  it('really waits between tokens when given a real clock', async () => {
    const real = createMockAdapter();
    const started = Date.now();
    const iterator = real
      .generate(
        { modelId: 'mock-slow', prompt: 'x', outputTypes: ['text'] },
        new AbortController().signal,
      )
      [Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await iterator.next();

    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    await iterator.return?.();
  });
});

describe('TC-EXE-005 mock-json and mock-bad-json', () => {
  it('mock-json returns the §2.6 verdict object, echoing the input', async () => {
    const value = jsonOf(await collect(run('mock-json', 'review this', { outputTypes: ['json'] })));

    expect(value).toEqual({ echo: 'review this', verdict: 'approved', score: 8, issues: [] });
  });

  it('mock-bad-json returns text that is not valid JSON', async () => {
    const text = textOf(await collect(run('mock-bad-json', 'x', { outputTypes: ['json'] })));

    expect(text).toBe('{ "oops": ');
    expect(() => JSON.parse(text)).toThrow();
  });

  it('mock-bad-json emits no json chunk, so the executor has to parse and fail', async () => {
    const chunks = await collect(run('mock-bad-json', 'x', { outputTypes: ['json'] }));

    expect(chunks.some((c) => c.type === 'json')).toBe(false);
  });
});

describe('Arch §28 the mock raises every error kind the engine has a rule for', () => {
  it('mock-503 throws a retryable provider error', async () => {
    await expect(collect(run('mock-503'))).rejects.toMatchObject({
      nodeError: { kind: 'provider', code: 'http_503', retryable: true },
    });
  });

  it('mock-401 throws an auth error that is never retried', async () => {
    await expect(collect(run('mock-401'))).rejects.toMatchObject({
      nodeError: { kind: 'auth', code: 'http_401', retryable: false },
    });
  });

  it('mock-refuse answers with a refusal instead of throwing', async () => {
    const chunks = await collect(run('mock-refuse'));

    expect(finishOf(chunks)?.reason).toBe('refusal');
    expect(textOf(chunks).toLowerCase()).toContain('cannot');
  });

  it('mock-refuse emits no json, so a json contract cannot be satisfied by it', async () => {
    // What makes it the `agent` kind: the answer is well formed and simply does not meet the
    // contract, which is the one failure worth a contract-repair retry (round 3 §2.1).
    const chunks = await collect(run('mock-refuse', 'answer as json', { outputTypes: ['json'] }));

    expect(chunks.some((chunk) => chunk.type === 'json')).toBe(false);
    expect(() => JSON.parse(textOf(chunks))).toThrow();
  });
});

describe('FR-PRV-010 mock-timeout honours the AbortSignal', () => {
  it('never yields, and ends when the signal aborts', async () => {
    const controller = new AbortController();
    const chunks: StreamChunk[] = [];

    const pending = (async () => {
      for await (const chunk of adapter().generate(
        { modelId: 'mock-timeout', prompt: 'x', outputTypes: ['text'] },
        controller.signal,
      )) {
        chunks.push(chunk);
      }
    })();

    controller.abort();
    await expect(pending).rejects.toMatchObject({ nodeError: { kind: 'user_cancelled' } });
    expect(chunks).toEqual([]);
  });
});

describe('Round 3 fixtures the mock already provides (§9 hand-off)', () => {
  it('mock-429-then-ok fails twice per run and then behaves as mock-text', async () => {
    const mock = adapter();
    const call = async (): Promise<StreamChunk[]> =>
      collect(
        mock.generate(
          { modelId: 'mock-429-then-ok', prompt: 'x', outputTypes: ['text'], runId: 'run-a' },
          new AbortController().signal,
        ),
      );

    await expect(call()).rejects.toMatchObject({ nodeError: { code: 'http_429' } });
    await expect(call()).rejects.toMatchObject({ nodeError: { code: 'http_429' } });
    expect(textOf(await call()).trim().split(/\s+/)).toHaveLength(40);
  });

  it('counts those failures per run, not per process', async () => {
    const mock = adapter();
    const call = async (runId: string): Promise<StreamChunk[]> =>
      collect(
        mock.generate(
          { modelId: 'mock-429-then-ok', prompt: 'x', outputTypes: ['text'], runId },
          new AbortController().signal,
        ),
      );

    await expect(call('run-a')).rejects.toThrow();
    await expect(call('run-a')).rejects.toThrow();
    await call('run-a');
    await expect(call('run-b')).rejects.toMatchObject({ nodeError: { code: 'http_429' } });
  });

  it('mock-repeat answers identically whatever the input', async () => {
    const first = textOf(await collect(run('mock-repeat', 'one')));
    const second = textOf(await collect(run('mock-repeat', 'something else entirely')));

    expect(first).toBe(second);
  });

  it('mock-reject-twice asks for changes on iterations 1 and 2 and approves on 3', async () => {
    const mock = adapter();
    const verdict = async (iteration: number): Promise<unknown> => {
      const chunks = await collect(
        mock.generate(
          { modelId: 'mock-reject-twice', prompt: 'x', outputTypes: ['json'], iteration },
          new AbortController().signal,
        ),
      );
      return (jsonOf(chunks) as { verdict: string }).verdict;
    };

    expect(await verdict(1)).toBe('changes_requested');
    expect(await verdict(2)).toBe('changes_requested');
    expect(await verdict(3)).toBe('approved');
  });

  it('mock-leak puts a credential-shaped string in its output', async () => {
    const text = textOf(await collect(run('mock-leak')));

    expect(text).toContain('FAKEFAKEFAKEFAKEFAKE0000');
    expect(text).toMatch(/sk-ant-api03-/);
  });
});

/* -------------------------------------------------------------------------- */
/* Round 3 additions                                                           */
/* -------------------------------------------------------------------------- */

describe('FR-PAR-005 mock-reject-always never approves, so a loop can only end at its maximum', () => {
  it('returns the ReviewContract §4 item 8 specifies, and nothing else', async () => {
    const value = jsonOf(await collect(run('mock-reject-always', 'x', { outputTypes: ['json'] })));

    expect(value).toEqual({ score: 4, verdict: 'changes_requested', issues: ['needs work'] });
  });

  it('is a valid ReviewContract, so REVIEW_CONTRACT_SCHEMA accepts it', async () => {
    const value = jsonOf(await collect(run('mock-reject-always', 'x', { outputTypes: ['json'] })));

    expect(ReviewContractSchema.safeParse(value).success).toBe(true);
  });

  it('answers identically on every iteration, however many the caller asks for', async () => {
    const mock = adapter();
    const verdicts: unknown[] = [];
    for (const iteration of [1, 2, 3, 4, 50]) {
      verdicts.push(
        jsonOf(
          await collect(
            mock.generate(
              {
                modelId: 'mock-reject-always',
                prompt: `draft ${iteration}`,
                outputTypes: ['json'],
                iteration,
              },
              new AbortController().signal,
            ),
          ),
        ),
      );
    }

    expect(new Set(verdicts.map((v) => JSON.stringify(v))).size).toBe(1);
  });
});

describe('FR-ERR-005 the attempt-dependent models count one node at a time', () => {
  it('mock-429-then-ok gives every node in a run its own two failures', async () => {
    const mock = adapter();
    const call = async (prompt: string): Promise<StreamChunk[]> =>
      collect(
        mock.generate(
          { modelId: 'mock-429-then-ok', prompt, outputTypes: ['text'], runId: 'run-a' },
          new AbortController().signal,
        ),
      );

    // Node A burns its two attempts. An automatic retry re-sends the identical prompt (§2.1).
    await expect(call('node A prompt')).rejects.toMatchObject({ nodeError: { code: 'http_429' } });
    await expect(call('node A prompt')).rejects.toMatchObject({ nodeError: { code: 'http_429' } });
    await call('node A prompt');

    // Node B, in the same run, still starts at attempt 1 rather than inheriting A's history.
    await expect(call('node B prompt')).rejects.toMatchObject({ nodeError: { code: 'http_429' } });
  });

  it('mock-reject-twice walks its script even when the caller sends no iteration', async () => {
    const mock = adapter();
    const verdict = async (prompt: string): Promise<unknown> => {
      const chunks = await collect(
        mock.generate(
          { modelId: 'mock-reject-twice', prompt, outputTypes: ['json'], runId: 'run-a' },
          new AbortController().signal,
        ),
      );
      return (jsonOf(chunks) as { verdict: string }).verdict;
    };

    expect(await verdict('draft one')).toBe('changes_requested');
    expect(await verdict('draft two')).toBe('changes_requested');
    expect(await verdict('draft three')).toBe('approved');
  });
});

describe('FR-CTL-003 a stop aborts an in-flight call at once', () => {
  it('mock-slow sleeps the two seconds §2.6 promises', async () => {
    let slept = 0;
    const mock = createMockAdapter({
      sleep: async (ms) => {
        slept += ms;
      },
    });

    await collect(
      mock.generate(
        { modelId: 'mock-slow', prompt: 'x', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    );

    expect(slept).toBe(2000);
  });

  it('stops mid-stream on a real clock in milliseconds, not after the whole two seconds', async () => {
    const controller = new AbortController();
    const real = createMockAdapter();
    const iterator = real
      .generate({ modelId: 'mock-slow', prompt: 'x', outputTypes: ['text'] }, controller.signal)
      [Symbol.asyncIterator]();

    await iterator.next();
    const abortedAt = Date.now();
    controller.abort();

    await expect(iterator.next()).rejects.toMatchObject({
      nodeError: { kind: 'user_cancelled', code: 'aborted', retryable: false },
    });
    // The abort must not wait out the 20 ms token timer, let alone the rest of the stream.
    expect(Date.now() - abortedAt).toBeLessThan(2000);
  });

  it('records the aborted call as failed, so a stop is visible in the log', async () => {
    const controller = new AbortController();
    const mock = adapter();
    const pending = collect(
      mock.generate(
        { modelId: 'mock-slow', prompt: 'x', outputTypes: ['text'] },
        controller.signal,
      ),
    );

    controller.abort();
    await expect(pending).rejects.toThrow();

    expect(mock.calls()[0]?.failed).toBe(true);
    expect(mock.calls()[0]?.endedAt).toBeDefined();
  });
});

describe('Arch §28 a timeout abort is a retryable network failure, a stop is not', () => {
  it('mock-timeout reports network when the abort reason is a TimeoutError', async () => {
    const controller = new AbortController();
    const pending = collect(
      adapter().generate(
        { modelId: 'mock-timeout', prompt: 'x', outputTypes: ['text'] },
        controller.signal,
      ),
    );

    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));

    await expect(pending).rejects.toMatchObject({
      nodeError: { kind: 'network', code: 'timeout', retryable: true },
    });
  });

  it('really is the reason AbortSignal.timeout() sets, not a name this file invented', async () => {
    const signal = AbortSignal.timeout(5);
    const pending = collect(
      adapter().generate({ modelId: 'mock-timeout', prompt: 'x', outputTypes: ['text'] }, signal),
    );

    await expect(pending).rejects.toMatchObject({ nodeError: { kind: 'network' } });
  });

  it('classifies a timeout in the middle of a stream the same way', async () => {
    const controller = new AbortController();
    const real = createMockAdapter();
    const iterator = real
      .generate({ modelId: 'mock-slow', prompt: 'x', outputTypes: ['text'] }, controller.signal)
      [Symbol.asyncIterator]();

    await iterator.next();
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));

    await expect(iterator.next()).rejects.toMatchObject({
      nodeError: { kind: 'network', retryable: true },
    });
  });

  it('leaves a plain user stop as user_cancelled, which is never retried', async () => {
    const controller = new AbortController();
    const pending = collect(
      adapter().generate(
        { modelId: 'mock-timeout', prompt: 'x', outputTypes: ['text'] },
        controller.signal,
      ),
    );

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      nodeError: { kind: 'user_cancelled', retryable: false },
    });
  });
});

describe('Round 5 fixtures the mock already provides', () => {
  it('mock-embed returns stable 64-dimension vectors', async () => {
    const mock = adapter();
    const first = await mock.embed?.(['alpha', 'beta']);
    const second = await mock.embed?.(['alpha']);

    expect(first).toHaveLength(2);
    expect(first?.[0]).toHaveLength(64);
    expect(second?.[0]).toEqual(first?.[0]);
  });
});

/* -------------------------------------------------------------------------- */
/* Round 4 — the tool loop (§2.6, FR-TOOL-003, Arch §12.7)                     */
/* -------------------------------------------------------------------------- */

describe('FR-TOOL-003 mock-tool requests echo once, then answers from the result', () => {
  it('asks for echo { text: <input> } and ends the turn on tool_calls, with no answer text', async () => {
    const chunks = await collect(run('mock-tool', 'hello there'));
    const calls = toolCallsOf(chunks);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('echo');
    expect(calls[0]?.args).toEqual({ text: 'hello there' });
    expect(finishOf(chunks)?.reason).toBe('tool_calls');
    expect(textOf(chunks)).toBe('');
  });

  it('gives the tool_call an IdSchema-shaped, stable callId', async () => {
    const first = toolCallsOf(await collect(run('mock-tool')))[0]?.callId ?? '';
    const second = toolCallsOf(await collect(run('mock-tool')))[0]?.callId ?? '';

    expect(first).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(first).toBe(second);
  });

  it('answers "echo said: <result>" once the echo result comes back, with no further tool call', async () => {
    const chunks = await collect(
      run('mock-tool', 'hello there', { toolResults: [toolResult('echo', { text: 'hello there' })] }),
    );

    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(textOf(chunks)).toBe('echo said: hello there');
    expect(finishOf(chunks)?.reason).toBe('stop');
  });
});

describe('TC-GRD-014 mock-tool-loop requests echo on every turn, however many results it is given', () => {
  it('requests echo when it has no results yet', async () => {
    const calls = toolCallsOf(await collect(run('mock-tool-loop')));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('echo');
  });

  it('still requests echo after a result — so the loop only ends at the call limit', async () => {
    const chunks = await collect(
      run('mock-tool-loop', 'x', { toolResults: [toolResult('echo', { text: 'x' })] }),
    );

    expect(toolCallsOf(chunks)).toHaveLength(1);
    expect(finishOf(chunks)?.reason).toBe('tool_calls');
  });

  it('still requests a tool even when asked to finish without tools (drives RUN_FAILED at the limit)', async () => {
    const chunks = await collect(run('mock-tool-loop', 'x', { tools: [] }));

    expect(toolCallsOf(chunks)).toHaveLength(1);
    expect(textOf(chunks)).toBe('');
  });
});

describe('FR-GRD-006 mock-destructive requests a destructive tool, then answers', () => {
  it('asks for sandbox_delete { path: "notes.txt" }', async () => {
    const calls = toolCallsOf(await collect(run('mock-destructive')));

    expect(calls[0]?.name).toBe('sandbox_delete');
    expect(calls[0]?.args).toEqual({ path: 'notes.txt' });
  });

  it('answers once the deletion result comes back', async () => {
    const chunks = await collect(
      run('mock-destructive', 'clean up', {
        toolResults: [toolResult('sandbox_delete', { deleted: true })],
      }),
    );

    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(finishOf(chunks)?.reason).toBe('stop');
    expect(textOf(chunks)).toContain('sandbox_delete');
  });
});

describe('FR-TOOL-005 mock-http requests the first URL in the input, then answers with the status', () => {
  it('GETs the first URL it finds in the prompt', async () => {
    const calls = toolCallsOf(
      await collect(run('mock-http', 'please fetch http://127.0.0.1:9000/thing and report')),
    );

    expect(calls[0]?.name).toBe('http_request');
    expect(calls[0]?.args).toEqual({ method: 'GET', url: 'http://127.0.0.1:9000/thing' });
  });

  it('answers with the returned status once the request result comes back', async () => {
    const chunks = await collect(
      run('mock-http', 'x', { toolResults: [toolResult('http_request', { status: 200 })] }),
    );

    expect(textOf(chunks)).toContain('200');
    expect(finishOf(chunks)?.reason).toBe('stop');
  });
});

describe('TC-TOOL-003 mock-search runs web_search then web_fetch then answers (two tool calls)', () => {
  it('starts with web_search { query: <input> }', async () => {
    const calls = toolCallsOf(await collect(run('mock-search', 'find the news')));

    expect(calls[0]?.name).toBe('web_search');
    expect(calls[0]?.args).toEqual({ query: 'find the news' });
  });

  it('web_fetches the first result URL after the search comes back', async () => {
    const chunks = await collect(
      run('mock-search', 'find the news', {
        toolResults: [
          toolResult('web_search', {
            results: [{ title: 'First', url: 'http://example.test/a', snippet: 's' }],
          }),
        ],
      }),
    );
    const calls = toolCallsOf(chunks);

    expect(calls[0]?.name).toBe('web_fetch');
    expect(calls[0]?.args).toEqual({ url: 'http://example.test/a' });
  });

  it('answers once the fetch result comes back, so a full run is exactly two tool calls', async () => {
    const chunks = await collect(
      run('mock-search', 'find the news', {
        toolResults: [toolResult('web_fetch', { title: 'First', text: 'the page body' })],
      }),
    );

    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(textOf(chunks)).toContain('First');
    expect(finishOf(chunks)?.reason).toBe('stop');
  });
});

describe('TC-TOOL-008 mock-mcp calls the first enabled mcp_ tool, then answers', () => {
  const mcpTool = {
    name: 'mcp_test_hello',
    description: 'an mcp tool',
    inputSchema: {},
    outputSchema: {},
    permissions: { network: true, fsPaths: [], destructive: false },
    timeoutMs: 1000,
    source: 'mcp' as const,
  };

  it('requests the first tool whose name starts with mcp_ with empty args', async () => {
    const calls = toolCallsOf(await collect(run('mock-mcp', 'go', { tools: [mcpTool] })));

    expect(calls[0]?.name).toBe('mcp_test_hello');
    expect(calls[0]?.args).toEqual({});
  });

  it('answers once the mcp tool result comes back', async () => {
    const chunks = await collect(
      run('mock-mcp', 'go', { tools: [mcpTool], toolResults: [toolResult('mcp_test_hello', {})] }),
    );

    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(finishOf(chunks)?.reason).toBe('stop');
  });

  it('answers directly when no mcp_ tool is enabled, rather than requesting one that is absent', async () => {
    const chunks = await collect(run('mock-mcp', 'go', { tools: [] }));

    expect(toolCallsOf(chunks)).toHaveLength(0);
    expect(finishOf(chunks)?.reason).toBe('stop');
  });
});

/* -------------------------------------------------------------------------- */
/* Round 4 — multimodal (§2.6, FR-MM-003, TC-MM-009)                          */
/* -------------------------------------------------------------------------- */

describe('TC-MM-009 mock-vision reads the image reference metadata from the prompt', () => {
  it('answers "Image <name> (<size> bytes, <mime>)" from a rendered reference', async () => {
    const text = textOf(
      await collect(
        run('mock-vision', 'Describe [image diagram.png (2048 bytes, image/png)]', {
          outputTypes: ['text'],
        }),
      ),
    );

    expect(text).toBe('Image diagram.png (2048 bytes, image/png)');
  });

  it('falls back to a bare [artifact NAME] reference, keeping the sentence shape', async () => {
    const text = textOf(
      await collect(run('mock-vision', 'Describe [artifact diagram.png]', { outputTypes: ['text'] })),
    );

    expect(text).toContain('Image diagram.png');
  });

  it('matches the shape formatArtifactReference renders, so the engine and the mock agree', async () => {
    const reference = formatArtifactReference({
      type: 'image',
      name: 'chart.webp',
      size: 4096,
      mime: 'image/webp',
    });
    const text = textOf(
      await collect(run('mock-vision', `Look at ${reference}`, { outputTypes: ['text'] })),
    );

    expect(text).toBe('Image chart.webp (4096 bytes, image/webp)');
  });
});

describe('FR-MM-003 mock-media emits one Part of each of the seven data types', () => {
  it('yields text, json, code, image, audio, video and file parts', async () => {
    const parts = partsOf(
      await collect(
        run('mock-media', 'make everything', {
          outputTypes: ['text', 'json', 'code', 'image', 'audio', 'video', 'file'],
        }),
      ),
    );

    expect(parts.map((p) => p.type)).toEqual([
      'text',
      'json',
      'code',
      'image',
      'audio',
      'video',
      'file',
    ]);
  });

  it('references media as artifacts with IdSchema-shaped ids and never inlines bytes (FR-MM-004)', async () => {
    const parts = partsOf(
      await collect(run('mock-media', 'x', { outputTypes: ['image', 'audio', 'video', 'file'] })),
    );
    const media = parts.filter(
      (p): p is Extract<Part, { artifactId: string }> =>
        p.type === 'image' || p.type === 'audio' || p.type === 'video' || p.type === 'file',
    );

    expect(media).toHaveLength(4);
    for (const part of media) {
      expect(part.artifactId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
      expect(part).not.toHaveProperty('bytes');
      expect(part).not.toHaveProperty('base64');
    }
    // The stored JSON of a media envelope must never carry raw bytes (BR-02).
    expect(JSON.stringify(parts)).not.toMatch(/bytes|base64/);
  });

  it('D-082: each media part carries its fixture bytes beside it, never inside it, and its size is theirs', async () => {
    const chunks = (
      await collect(run('mock-media', 'x', { outputTypes: ['image', 'audio', 'video', 'file'] }))
    ).filter((c): c is Extract<StreamChunk, { type: 'part' }> => c.type === 'part');

    const media = chunks.filter((chunk) => MOCK_MEDIA_TYPES.some((type) => type === chunk.part.type));
    expect(media.map((chunk) => chunk.part.type)).toEqual([...MOCK_MEDIA_TYPES]);
    for (const { part, bytes } of media) {
      if (part.type === 'text' || part.type === 'json' || part.type === 'code') continue;
      const fixture = mockMediaFixture(part.type);
      // The bytes the engine stores (FR-MM-003) — the real file, not a zero-filled stand-in.
      expect(bytes, part.type).toEqual(fixture.bytes);
      expect(part.size, part.type).toBe(fixture.bytes.byteLength);
      expect(part.mime, part.type).toBe(fixture.mime);
      expect(part.name, part.type).toBe(fixture.name);
      // FR-MM-004: the Part itself stays a reference; the bytes ride on the chunk only.
      expect(PartSchema.safeParse(part).success, part.type).toBe(true);
      expect(Object.keys(part), part.type).not.toContain('bytes');
    }
    // Text, JSON and code have no bytes to store.
    for (const { part, bytes } of chunks.filter((chunk) => !media.includes(chunk))) {
      expect(bytes, part.type).toBeUndefined();
    }
  });

  it('every part parses against the contract PartSchema and the ids are stable', async () => {
    const first = partsOf(await collect(run('mock-media', 'x', { outputTypes: ['image'] })));
    const second = partsOf(await collect(run('mock-media', 'x', { outputTypes: ['image'] })));

    for (const part of first) expect(PartSchema.safeParse(part).success).toBe(true);
    expect(first).toEqual(second);
  });

  it('finishes with reason stop after the parts', async () => {
    const chunks = await collect(run('mock-media', 'x', { outputTypes: ['text', 'json'] }));

    expect(finishOf(chunks)?.reason).toBe('stop');
  });
});

/* -------------------------------------------------------------------------- */
/* Round 4 — direct chat (§2.6, FR-CHAT-004/006)                              */
/* -------------------------------------------------------------------------- */

describe('FR-CHAT-006 mock-chat echoes the input, streamed, and answers in French on request', () => {
  it('streams "You said: <input>" word by word', async () => {
    const chunks = await collect(run('mock-chat', 'good morning'));

    expect(textOf(chunks)).toContain('You said: good morning');
    // Streamed: more than one text chunk for a multi-word reply.
    expect(chunks.filter((c) => c.type === 'text').length).toBeGreaterThan(1);
    expect(finishOf(chunks)?.reason).toBe('stop');
  });

  it('replies in French when the instructions ask for it (via the system section)', async () => {
    const text = textOf(await collect(run('mock-chat', 'bonjour', { system: 'Answer in French.' })));

    expect(text).toContain('Vous avez dit');
  });

  it('replies in French when the instruction sits in the prompt body', async () => {
    const text = textOf(await collect(run('mock-chat', 'Answer in French. bonjour')));

    expect(text).toContain('Vous avez dit');
  });
});

describe('FR-PRV-010 an unknown model is a configuration error, not a crash', () => {
  it('throws invalid_config naming the model', async () => {
    await expect(collect(run('mock-nope'))).rejects.toMatchObject({
      nodeError: { kind: 'invalid_config' },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The call log                                                                */
/* -------------------------------------------------------------------------- */

describe('§2.6 every mock call is recorded so "zero provider calls" is assertable', () => {
  it('starts empty and records each call with its model and prompt', async () => {
    const mock = adapter();
    expect(mock.calls()).toEqual([]);

    await collect(
      mock.generate(
        { modelId: 'mock-text', prompt: 'hello there', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    );

    expect(mock.calls()).toHaveLength(1);
    expect(mock.calls()[0]?.modelId).toBe('mock-text');
    expect(mock.calls()[0]?.prompt).toBe('hello there');
    expect(mock.calls()[0]?.endedAt).toBeGreaterThanOrEqual(mock.calls()[0]?.startedAt ?? 0);
  });

  it('records a call that failed, so a retry is visible', async () => {
    const mock = adapter();
    await expect(
      collect(
        mock.generate(
          { modelId: 'mock-503', prompt: 'x', outputTypes: ['text'] },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow();

    expect(mock.calls()).toHaveLength(1);
    expect(mock.calls()[0]?.failed).toBe(true);
  });

  it('reset() empties the log and the per-run counters', async () => {
    const mock = adapter();
    await expect(
      collect(
        mock.generate(
          { modelId: 'mock-429-then-ok', prompt: 'x', outputTypes: ['text'], runId: 'r' },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow();

    mock.reset();
    expect(mock.calls()).toEqual([]);
    expect(mock.maxConcurrent()).toBe(0);
  });

  it('tracks how many calls overlapped, which is what TC-PRV-009 measures', async () => {
    const mock = adapter();
    const one = collect(
      mock.generate(
        { modelId: 'mock-text', prompt: 'a', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    );
    const two = collect(
      mock.generate(
        { modelId: 'mock-text', prompt: 'b', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    );
    await Promise.all([one, two]);

    expect(mock.maxConcurrent()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* mock-script (D315)                                                          */
/* -------------------------------------------------------------------------- */

describe('D315 mock-script plays each node its [[turn N]] section', () => {
  const SCRIPT = [
    'Act as the Writer.',
    '[[turn 1]]',
    'Draft one.',
    '[[turn 2]]',
    'Draft two:',
    '```ace-envelope',
    '{"kind":"FLAG","to":["@review"],"summary":"Look again."}',
    '```',
    '[[turn 3]]',
    'Final draft.',
  ].join('\n');
  const promptFor = (instructions: string, rest = ''): string =>
    `## System\nbase\n\n## Instructions\n${instructions}\n\n## Input\n${rest}\n`;
  const call = (
    a: ReturnType<typeof adapter>,
    runId: string,
    prompt: string,
    signal = new AbortController().signal,
  ) =>
    collect(a.generate({ modelId: 'mock-script', prompt, outputTypes: ['text'], runId }, signal), signal);

  it('walks the sections turn by turn, keeps their lines, and repeats the last one', async () => {
    const a = adapter();
    const turns = [];
    for (let n = 0; n < 4; n += 1) turns.push(textOf(await call(a, 'run-1', promptFor(SCRIPT))));
    expect(turns[0]).toBe('Draft one.');
    expect(turns[1]).toBe(
      'Draft two:\n```ace-envelope\n{"kind":"FLAG","to":["@review"],"summary":"Look again."}\n```',
    );
    expect(turns[2]).toBe('Final draft.');
    expect(turns[3]).toBe('Final draft.');
    // Another run starts its script again.
    expect(textOf(await call(a, 'run-2', promptFor(SCRIPT)))).toBe('Draft one.');
  });

  it('reports what it used, counted in words', async () => {
    const chunks = await call(adapter(), 'run-1', promptFor(SCRIPT));
    expect(usageOf(chunks)).toEqual({ type: 'usage', tokensIn: expect.any(Number), tokensOut: 2 });
    expect(finishOf(chunks)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('answers the QUERY its prompt quotes, through {{query}}', async () => {
    const script = '[[turn *]]\n```ace-envelope\n{"kind":"ANSWER","to":["@writer"],"summary":"2026.","inReplyTo":"{{query}}"}\n```';
    const prompt = promptFor(script, '## Team messages\n[QUERY 01JBXQ8Z9KQ4R7N2VWXYZ0E001] from @writer: Which year?');
    expect(textOf(await call(adapter(), 'run-1', prompt))).toContain(
      '"inReplyTo":"01JBXQ8Z9KQ4R7N2VWXYZ0E001"',
    );
  });

  it('[[hold]] writes what comes before it, then holds until the call is aborted', async () => {
    const controller = new AbortController();
    const seen: StreamChunk[] = [];
    const stream = adapter().generate(
      {
        modelId: 'mock-script',
        prompt: promptFor('[[turn 1]]\nThinking it over\n[[hold]]'),
        outputTypes: ['text'],
        runId: 'run-1',
      },
      controller.signal,
    );
    await (async () => {
      for await (const chunk of stream) {
        seen.push(chunk);
        if (chunk.type === 'text') setTimeout(() => controller.abort(), 20);
      }
    })().catch(() => undefined);
    expect(controller.signal.aborted).toBe(true);
    expect(textOf(seen).trim()).toBe('Thinking it over');
    expect(seen.some((c) => c.type === 'finish')).toBe(false);
  });

  it('a contract repair is the next call: the reason it was rejected never reads as script', async () => {
    const a = adapter();
    const repaired = `${SCRIPT}\n\nYour previous answer was rejected: bad\nAnswer again, satisfying the output contract exactly.`;
    expect(textOf(await call(a, 'run-1', promptFor(SCRIPT)))).toBe('Draft one.');
    expect(textOf(await call(a, 'run-1', promptFor(repaired)))).toBe(
      'Draft two:\n```ace-envelope\n{"kind":"FLAG","to":["@review"],"summary":"Look again."}\n```',
    );
  });
});

describe('D302 a chat turn has no run, so the mock counts its calls per turn', () => {
  it('gives each chat turn its own attempts instead of one shared "no run"', async () => {
    const mock = adapter();
    const call = async (turnId: string): Promise<StreamChunk[]> =>
      collect(
        mock.generate(
          { modelId: 'mock-429-then-ok', prompt: 'x', outputTypes: ['text'], turnId },
          new AbortController().signal,
        ),
      );

    await expect(call('turn-a')).rejects.toMatchObject({ nodeError: { code: 'http_429' } });
    await expect(call('turn-a')).rejects.toMatchObject({ nodeError: { code: 'http_429' } });
    await call('turn-a');
    // a second chat turn starts its own count, as a second run would
    await expect(call('turn-b')).rejects.toMatchObject({ nodeError: { code: 'http_429' } });
  });
});
