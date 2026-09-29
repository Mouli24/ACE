import { describe, expect, it } from 'vitest';

import { ProviderCallError, mapProviderError, type StreamChunk } from '../adapter.js';
import { getJson, type FetchLike } from '../adapters/ai-sdk.js';
import { createOpenAiCompatibleAdapter } from '../adapters/openai-compatible.js';

/**
 * FR-EXE-010, FR-ERR-001, TC-ERR-001, D97, D109: a call cut off by its own timeout is a `network`
 * failure the engine retries; a call the user stopped is `user_cancelled`, and is not.
 *
 * The executor hands the adapter `AbortSignal.any([stop, AbortSignal.timeout(timeoutMs)])`, and the
 * two are told apart only by the signal's reason. Only the mock adapter read it: the real ones put
 * `TimeoutError` among the abort names, so a timeout on a real provider became a cancellation —
 * the node ended STOPPED, was never retried, and the run halted `failure` with no FAILED node.
 */

const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

const TIMED_OUT = { kind: 'network', code: 'timeout', retryable: true } as const;
const CANCELLED = { kind: 'user_cancelled', code: 'aborted', retryable: false } as const;

const timeoutError = (): DOMException =>
  new DOMException('The operation timed out.', 'TimeoutError');
const abortError = (): DOMException => new DOMException('This operation was aborted', 'AbortError');

/** The signal the executor builds: a stop, or `execution.timeoutMs`, whichever comes first. */
function callSignal(timeoutMs: number): { signal: AbortSignal; stop: () => void } {
  const stop = new AbortController();
  return {
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]),
    stop: () => stop.abort(),
  };
}

describe('FR-ERR-001 D109 mapProviderError tells a timeout from a stop', () => {
  it('maps a TimeoutError to a retryable network failure, not a cancellation', () => {
    expect(mapProviderError(timeoutError(), { providerId: PROVIDER_ID })).toMatchObject({
      ...TIMED_OUT,
      providerId: PROVIDER_ID,
    });
  });

  it("reads an AbortError's real reason off the call's signal (D97)", () => {
    const signal = AbortSignal.abort(timeoutError());

    expect(mapProviderError(abortError(), { signal })).toMatchObject(TIMED_OUT);
  });

  it('keeps an abort a cancellation when the signal was stopped, or is not known', () => {
    const stopped = new AbortController();
    stopped.abort();

    expect(mapProviderError(abortError(), { signal: stopped.signal })).toMatchObject(CANCELLED);
    expect(mapProviderError(abortError())).toMatchObject(CANCELLED);
  });
});

/* -------------------------------------------------------------------------- */
/* A real adapter against a provider that goes quiet                           */
/* -------------------------------------------------------------------------- */

/** How the transport reports the abort: with the signal's own reason (undici), or a bare AbortError. */
type AbortShape = 'reason' | 'abort-error';

const rejection = (signal: AbortSignal, shape: AbortShape): unknown =>
  shape === 'reason' ? signal.reason : abortError();

/** A provider that accepts the request and never answers. */
function silentFetch(shape: AbortShape): FetchLike {
  return async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) return;
      signal.addEventListener('abort', () => reject(rejection(signal, shape)), { once: true });
    });
}

/** A provider that starts streaming, sends one word, and then goes quiet. */
function stallingFetch(shape: AbortShape): FetchLike {
  return async (_url, init) => {
    const signal = init?.signal;
    const first = `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'local-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }],
    })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
        signal?.addEventListener('abort', () => controller.error(rejection(signal, shape)), {
          once: true,
        });
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  };
}

async function generate(fetchImpl: FetchLike, signal: AbortSignal): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  const stream = createOpenAiCompatibleAdapter({
    baseUrl: 'http://localhost:1234',
    fetchImpl,
  }).generate({ modelId: 'local-model', prompt: 'say hello', outputTypes: ['text'] }, signal);
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function failureOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error('the call ended as if it had finished');
}

describe('TC-ERR-001 FR-EXE-010 a real adapter reports its own timeout as network / timeout', () => {
  it.each([
    ['before any answer, reported with the signal reason', silentFetch('reason')],
    ['before any answer, reported as a bare AbortError', silentFetch('abort-error')],
    ['mid-stream, reported with the signal reason', stallingFetch('reason')],
    ['mid-stream, reported as a bare AbortError', stallingFetch('abort-error')],
  ])('times out %s', async (_label, fetchImpl) => {
    const { signal } = callSignal(30);

    const error = await failureOf(generate(fetchImpl, signal));

    expect(error).toBeInstanceOf(ProviderCallError);
    expect((error as ProviderCallError).nodeError).toMatchObject(TIMED_OUT);
  });

  it.each([
    ['before any answer', silentFetch('reason')],
    ['mid-stream', stallingFetch('abort-error')],
  ])('keeps a stop %s a cancellation, never retried', async (_label, fetchImpl) => {
    const { signal, stop } = callSignal(60_000);
    setTimeout(stop, 20);

    const error = await failureOf(generate(fetchImpl, signal));

    expect(error).toBeInstanceOf(ProviderCallError);
    expect((error as ProviderCallError).nodeError).toMatchObject(CANCELLED);
  });
});

describe('FR-PRV-003 a reachability probe that times out is still reported as such', () => {
  it('names the timeout it waited for', async () => {
    const error = await failureOf(
      getJson({
        url: 'http://localhost:1234/v1/models',
        fetchImpl: silentFetch('reason'),
        timeoutMs: 20,
      }),
    );

    expect((error as ProviderCallError).nodeError).toEqual({
      kind: 'network',
      code: 'timeout',
      message: 'The provider did not answer within 20 ms.',
      retryable: true,
    });
  });
});
