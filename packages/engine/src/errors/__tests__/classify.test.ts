import type { ErrorKind } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  AceNodeError,
  agentRefusalError,
  approvalRejectedError,
  authError,
  classifyError,
  contractViolationError,
  guardrailError,
  invalidConfigError,
  networkError,
  nodeErrorOf,
  providerError,
  upstreamFailedError,
  userCancelledError,
} from '../index.js';

const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';

describe('TC-ERR-001 Error classification (FR-ERR-001, Arch §28)', () => {
  /**
   * One case per kind, driven by the failure the mock provider actually produces for it — the
   * `mock-*` model names of R3 §4 item 2 are how these arrive end to end, and the shape each one
   * throws is what is simulated here.
   */
  const cases: { kind: ErrorKind; what: string; thrown: unknown }[] = [
    {
      kind: 'user_cancelled',
      what: 'stop aborts the signal (mock-slow + Stop)',
      thrown: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    },
    {
      kind: 'agent',
      what: 'the model declines (mock-refuse)',
      thrown: agentRefusalError('I cannot help with that.'),
    },
    {
      kind: 'provider',
      what: 'a 503 from the provider (mock-503)',
      thrown: Object.assign(new Error('upstream unavailable'), { status: 503 }),
    },
    {
      kind: 'auth',
      what: 'a 401 from the provider (mock-401)',
      thrown: Object.assign(new Error('invalid api key'), { status: 401 }),
    },
    {
      kind: 'network',
      what: 'the call never connects (mock-timeout)',
      thrown: Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }),
    },
    {
      kind: 'invalid_config',
      what: 'the node names a model that is not there',
      thrown: invalidConfigError('missing_model', 'No model is set on "Writer".'),
    },
    {
      kind: 'workflow',
      what: 'an upstream node failed',
      thrown: upstreamFailedError('Writer'),
    },
    {
      kind: 'guardrail',
      what: 'a policy blocked the output (mock-leak + secret_leak block)',
      thrown: guardrailError('The output contains an API key.', 'secret_leak'),
    },
  ];

  for (const { kind, what, thrown } of cases) {
    it(`classifies ${kind}: ${what}`, () => {
      expect(classifyError(thrown).kind).toBe(kind);
    });
  }

  it('covers all eight kinds and nothing twice', () => {
    expect(new Set(cases.map((row) => row.kind)).size).toBe(8);
  });

  it('a 429 is a provider error and is retryable (FR-ERR-005)', () => {
    const error = classifyError(Object.assign(new Error('slow down'), { status: 429 }));
    expect(error.kind).toBe('provider');
    expect(error.retryable).toBe(true);
    expect(error.code).toBe('http_429');
  });

  it('a 403 is auth and is never retryable', () => {
    const error = classifyError(Object.assign(new Error('forbidden'), { statusCode: 403 }));
    expect(error.kind).toBe('auth');
    expect(error.retryable).toBe(false);
  });

  it('a 400 is invalid_config, because retrying a malformed request cannot help', () => {
    const error = classifyError({ response: { status: 400 }, message: 'bad request' });
    expect(error.kind).toBe('invalid_config');
    expect(error.retryable).toBe(false);
  });

  it('a TimeoutError is network, not a cancellation', () => {
    const error = classifyError(
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    );
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });

  it('an abort is a cancellation whichever shape the runtime used', () => {
    for (const thrown of [
      Object.assign(new Error('x'), { name: 'AbortError' }),
      Object.assign(new Error('x'), { code: 'ABORT_ERR' }),
      Object.assign(new Error('x'), { code: 20 }),
    ]) {
      expect(classifyError(thrown).kind).toBe('user_cancelled');
    }
  });

  it('believes an error that already carries a NodeError, and keeps its code', () => {
    const declared = providerError('overloaded', 'The provider is overloaded.');
    expect(classifyError(declared)).toEqual(declared.nodeError);
  });

  it('believes a plain object carrying a NodeError, as the executor already does', () => {
    const thrown = Object.assign(new Error('rate limited'), {
      nodeError: { kind: 'provider', code: 'rate_limited', message: 'slow down', retryable: true },
    });
    expect(classifyError(thrown).code).toBe('rate_limited');
  });

  it('ignores a `nodeError` field that is not one', () => {
    expect(nodeErrorOf(Object.assign(new Error('x'), { nodeError: { kind: 'provider' } }))).toBeUndefined();
    expect(nodeErrorOf(Object.assign(new Error('x'), { nodeError: 'provider' }))).toBeUndefined();
    expect(nodeErrorOf(null)).toBeUndefined();
    expect(nodeErrorOf('a string')).toBeUndefined();
  });

  it('stamps the provider id on an error that does not name one (FR-ERR-002)', () => {
    const error = classifyError(new Error('boom'), { providerId: PROVIDER_ID });
    expect(error.providerId).toBe(PROVIDER_ID);
  });

  it('does not overwrite a provider id the error already names', () => {
    const declared = authError('bad key', '01JBXQ8Z9KQ4R7N2VWXYZ0OTHER'.slice(0, 26));
    expect(classifyError(declared, { providerId: PROVIDER_ID }).providerId).not.toBe(PROVIDER_ID);
  });

  it('reads the status from the context when the caller has it rather than the error', () => {
    expect(classifyError(new Error('nope'), { status: 500 }).kind).toBe('provider');
  });

  it('a stop in flight explains a failure nothing else recognises', () => {
    expect(classifyError(new Error('stream ended oddly'), { stopped: true }).kind).toBe(
      'user_cancelled',
    );
  });

  it('falls back to a non-retryable provider error, never to a guess that retries', () => {
    const error = classifyError('something odd');
    expect(error.kind).toBe('provider');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('something odd');
  });

  it('reads a network code off the cause of a wrapped fetch failure', () => {
    const error = classifyError(
      Object.assign(new Error('request to http://localhost failed'), {
        cause: { code: 'ENOTFOUND' },
      }),
    );
    expect(error.kind).toBe('network');
    expect(error.code).toBe('ENOTFOUND');
  });

  it('a 408 is a network timeout, not a provider outage', () => {
    expect(classifyError({ status: 408, message: 'too slow' }).kind).toBe('network');
  });
});

describe('FR-ERR-001 the constructors state a kind outright', () => {
  it('AceNodeError carries its NodeError as its message and on `nodeError`', () => {
    const error = networkError('ETIMEDOUT', 'The provider did not answer.');
    expect(error).toBeInstanceOf(AceNodeError);
    expect(error.message).toBe('The provider did not answer.');
    expect(error.nodeError.kind).toBe('network');
  });

  it('a contract violation is an agent error, and retryable once (§2.1, D85)', () => {
    const error = contractViolationError('score must be a number');
    expect(error.nodeError.kind).toBe('agent');
    expect(error.nodeError.code).toBe('contract_violation');
    expect(error.nodeError.retryable).toBe(true);
  });

  it('a rejected approval is a guardrail error and quotes the note (FR-GRD-013)', () => {
    expect(approvalRejectedError('too risky').nodeError.message).toContain('too risky');
    expect(approvalRejectedError().nodeError.message).toBe('The approval was rejected.');
    expect(approvalRejectedError('').nodeError.message).toBe('The approval was rejected.');
  });

  it('an upstream failure names the node that blocked this one (FR-ERR-006)', () => {
    const error = upstreamFailedError('Writer', '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD');
    expect(error.nodeError.message).toContain('"Writer"');
    expect(error.nodeError.details).toEqual({ blockedByNodeId: '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD' });
  });

  it('a user cancellation is never retryable', () => {
    expect(userCancelledError().nodeError.retryable).toBe(false);
  });

  it('a provider error can be declared non-retryable when the caller knows it is final', () => {
    expect(providerError('gone', 'The model was withdrawn.', { retryable: false }).nodeError
      .retryable).toBe(false);
  });

  it('a guardrail error records the check type it came from, never the value (FR-GRD-014)', () => {
    expect(guardrailError('An email was found.', 'pii').nodeError.details).toEqual({
      checkType: 'pii',
    });
  });
});
