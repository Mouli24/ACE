import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ERROR_CODE_HTTP_STATUS,
  ApiErrorSchema,
  PolicyInUseDetailsSchema,
  ROUND_1_ERROR_CODES,
  ROUND_3_ERROR_CODES,
  aceError,
} from '../errors.js';
import { NODE_A } from './fixtures.js';

describe('FR-SYS-006 error shape', () => {
  it('returns exactly the round 1 §2.3 envelope', () => {
    const error = aceError('invalid_config', 'validation_failed', 'temperature must be 0..2');

    expect(error).toEqual({
      error: {
        kind: 'invalid_config',
        code: 'validation_failed',
        message: 'temperature must be 0..2',
        retryable: false,
      },
    });
    expect(ApiErrorSchema.parse(error)).toEqual(error);
  });

  it('omits `details` entirely when none is given', () => {
    const error = aceError('workflow', 'not_found', 'no such workflow');

    expect('details' in error.error).toBe(false);
  });

  it('carries `details` through unchanged', () => {
    const error = aceError('workflow', 'stale_version', 'graph moved on', {
      details: { currentVersion: 7 },
    });

    expect(error.error.details).toEqual({ currentVersion: 7 });
    expect(ApiErrorSchema.parse(error).error.details).toEqual({ currentVersion: 7 });
  });

  it.each([
    ['provider', true],
    ['network', true],
    ['auth', false],
    ['user_cancelled', false],
    ['agent', false],
    ['invalid_config', false],
    ['workflow', false],
    ['guardrail', false],
  ] as const)('defaults retryable to %s -> %s (Arch §28)', (kind, retryable) => {
    expect(aceError(kind, 'internal', 'x').error.retryable).toBe(retryable);
  });

  it('lets the caller override retryable', () => {
    expect(aceError('provider', 'internal', 'x', { retryable: false }).error.retryable).toBe(false);
    expect(aceError('auth', 'internal', 'x', { retryable: true }).error.retryable).toBe(true);
  });

  it('rejects an envelope missing retryable', () => {
    const result = ApiErrorSchema.safeParse({
      error: { kind: 'auth', code: 'unauthorized', message: 'no token' },
    });

    expect(result.success).toBe(false);
  });

  it('rejects an envelope whose kind is not an ErrorKind', () => {
    const result = ApiErrorSchema.safeParse({
      error: { kind: 'nope', code: 'unauthorized', message: 'no token', retryable: false },
    });

    expect(result.success).toBe(false);
  });
});

describe('FR-SYS-006 round 1 error codes', () => {
  it('declares exactly the nine codes of round 1 §2.3', () => {
    expect([...ROUND_1_ERROR_CODES]).toEqual([
      'unauthorized',
      'forbidden_origin',
      'not_found',
      'validation_failed',
      'stale_version',
      'invalid_path',
      'unsupported_format_version',
      'not_implemented',
      'internal',
    ]);
  });

  it('adds provider_in_use, then round 3 §2.5 invalid_run_state and policy_in_use', () => {
    expect([...ROUND_3_ERROR_CODES]).toEqual(['invalid_run_state', 'policy_in_use']);
    expect([...ERROR_CODES]).toEqual([
      ...ROUND_1_ERROR_CODES,
      'provider_in_use',
      'invalid_run_state',
      'policy_in_use',
    ]);
  });

  it('maps every code to the HTTP status §2.3 gives it', () => {
    expect(ERROR_CODE_HTTP_STATUS).toEqual({
      unauthorized: 401,
      forbidden_origin: 403,
      not_found: 404,
      validation_failed: 400,
      stale_version: 409,
      invalid_path: 400,
      unsupported_format_version: 400,
      not_implemented: 501,
      internal: 500,
      provider_in_use: 409,
      invalid_run_state: 409,
      policy_in_use: 409,
    });
  });
});

describe('R3 §2.5 409 details', () => {
  it('FR-GRD-001 names the agents that still use a policy (policy_in_use)', () => {
    expect(PolicyInUseDetailsSchema.parse({ nodeIds: [NODE_A] })).toEqual({ nodeIds: [NODE_A] });
    expect(PolicyInUseDetailsSchema.safeParse({ nodeIds: ['node-a'] }).success).toBe(false);
  });
});
