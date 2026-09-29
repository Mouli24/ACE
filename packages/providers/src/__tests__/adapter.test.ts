import { describe, expect, it } from 'vitest';

import {
  ProviderCallError,
  isAbortError,
  mapProviderError,
  statusToNodeError,
} from '../adapter.js';

const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

describe('Arch §28 HTTP status maps to an ACE error kind', () => {
  it.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'provider', true],
    [500, 'provider', true],
    [502, 'provider', true],
    [503, 'provider', true],
    [504, 'provider', true],
  ] as const)('maps %i to kind %s (retryable %s)', (status, kind, retryable) => {
    const error = statusToNodeError(status, 'upstream said no');

    expect(error.kind).toBe(kind);
    expect(error.retryable).toBe(retryable);
    expect(error.code).toBe(`http_${status}`);
  });

  it('treats a 4xx that is not auth as invalid_config, which pre-flight can act on', () => {
    const error = statusToNodeError(400, 'model not found');

    expect(error.kind).toBe('invalid_config');
    expect(error.retryable).toBe(false);
  });

  it('keeps the upstream message and the provider it came from', () => {
    const error = statusToNodeError(503, 'service unavailable', { providerId: PROVIDER_ID });

    expect(error.message).toContain('service unavailable');
    expect(error.providerId).toBe(PROVIDER_ID);
  });
});

describe('Arch §28 transport failures are network errors', () => {
  it.each(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'])(
    'maps %s to a retryable network error',
    (code) => {
      const error = mapProviderError(Object.assign(new Error('socket failed'), { code }));

      expect(error.kind).toBe('network');
      expect(error.retryable).toBe(true);
      expect(error.code).toBe(code);
    },
  );

  it('maps a fetch TypeError to a network error', () => {
    const error = mapProviderError(new TypeError('fetch failed'));

    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });
});

describe('Arch §28 a cancelled call is never retried', () => {
  it.each([
    ['an AbortError by name', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    // A TimeoutError is not a cancellation but a network failure (D97, D109): timeout.test.ts.
    ['a DOMException-style abort', new DOMException('x', 'AbortError')],
  ])('maps %s to user_cancelled', (_label, thrown) => {
    const error = mapProviderError(thrown);

    expect(error.kind).toBe('user_cancelled');
    expect(error.retryable).toBe(false);
  });

  it('recognises an abort without mapping it', () => {
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
  });
});

describe('Arch §28 an adapter may raise an already-mapped error', () => {
  it('passes a ProviderCallError through unchanged', () => {
    const original = {
      kind: 'agent' as const,
      code: 'refusal',
      message: 'the model declined',
      retryable: false,
    };

    expect(mapProviderError(new ProviderCallError(original))).toEqual(original);
  });

  it('carries the node error on the thrown object, so a catch can read it directly', () => {
    const thrown = new ProviderCallError({
      kind: 'provider',
      code: 'http_503',
      message: 'down',
      retryable: true,
    });

    expect(thrown.nodeError.code).toBe('http_503');
    expect(thrown.message).toContain('down');
  });
});

describe('Arch §28 anything unrecognised is a provider error that is not retried', () => {
  it('maps a plain Error', () => {
    const error = mapProviderError(new Error('something odd'));

    expect(error.kind).toBe('provider');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('something odd');
  });

  it('maps a thrown non-Error', () => {
    const error = mapProviderError('just a string');

    expect(error.kind).toBe('provider');
    expect(error.message).toContain('just a string');
  });

  it('reads a statusCode off an SDK error object', () => {
    const error = mapProviderError(
      Object.assign(new Error('rate limited'), { statusCode: 429 }),
    );

    expect(error.kind).toBe('provider');
    expect(error.code).toBe('http_429');
    expect(error.retryable).toBe(true);
  });

  it('reads `status` as well, which is what fetch-based SDKs use', () => {
    expect(mapProviderError(Object.assign(new Error('nope'), { status: 401 })).kind).toBe('auth');
  });
});

describe('FR-PRV-003 a failed call also says what the provider state is now', () => {
  it.each([
    ['auth', 'AUTH_FAILED'],
    ['network', 'UNREACHABLE'],
  ] as const)('an %s error means %s', async (kind, expected) => {
    const { providerStateForError } = await import('../adapter.js');

    expect(providerStateForError({ kind, code: 'x', message: 'x', retryable: false })).toBe(
      expected,
    );
  });

  it('a 429 means RATE_LIMITED', async () => {
    const { providerStateForError } = await import('../adapter.js');

    expect(
      providerStateForError({ kind: 'provider', code: 'http_429', message: 'x', retryable: true }),
    ).toBe('RATE_LIMITED');
  });

  it('any other provider error leaves the state UNKNOWN rather than guessing', async () => {
    const { providerStateForError } = await import('../adapter.js');

    expect(
      providerStateForError({ kind: 'provider', code: 'http_500', message: 'x', retryable: true }),
    ).toBe('UNKNOWN');
  });
});
