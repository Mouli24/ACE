import {
  AUTO_RETRY_POLICY,
  CONTRACT_REPAIR_RETRIES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  type ErrorKind,
  type NodeError,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { autoRetryDecision, autoRetryMode, backoffDelayMs, backoffSchedule } from '../index.js';

const errorOf = (kind: ErrorKind, code = 'x'): NodeError => ({
  kind,
  code,
  message: kind,
  retryable: kind === 'provider' || kind === 'network',
});

describe('TC-ERR-005 Automatic retry policy (FR-ERR-005, R3 §2.1, D95)', () => {
  it('the backoff is 500 ms · 2^(attempt-1), capped at 8 s, with no jitter', () => {
    expect(backoffDelayMs(1)).toBe(500);
    expect(backoffDelayMs(2)).toBe(1_000);
    expect(backoffDelayMs(3)).toBe(2_000);
    expect(backoffDelayMs(4)).toBe(4_000);
    expect(backoffDelayMs(5)).toBe(8_000);
    expect(backoffDelayMs(6)).toBe(8_000);
    expect(backoffDelayMs(50)).toBe(RETRY_BACKOFF_MAX_MS);
  });

  it('the first wait is exactly the base from the contract', () => {
    expect(backoffDelayMs(1)).toBe(RETRY_BACKOFF_BASE_MS);
  });

  it('is deterministic — the same attempt always waits the same, so a test can assert it', () => {
    const first = Array.from({ length: 20 }, () => backoffDelayMs(3));
    expect(new Set(first).size).toBe(1);
  });

  it('treats attempt 0 and negatives as the first attempt rather than dividing the base', () => {
    expect(backoffDelayMs(0)).toBe(500);
    expect(backoffDelayMs(-4)).toBe(500);
  });

  it('a schedule is the sequence of waits a node with that budget would make', () => {
    expect(backoffSchedule(4)).toEqual([500, 1_000, 2_000, 4_000]);
    expect(backoffSchedule(0)).toEqual([]);
    expect(backoffSchedule(-1)).toEqual([]);
  });

  it('honours an overridden base and cap without changing the shape of the curve', () => {
    expect(backoffSchedule(4, { baseMs: 100, maxMs: 300 })).toEqual([100, 200, 300, 300]);
  });

  it('every mode comes from the contract table, never from a second copy', () => {
    for (const kind of Object.keys(AUTO_RETRY_POLICY) as ErrorKind[]) {
      expect(autoRetryMode(kind)).toBe(AUTO_RETRY_POLICY[kind]);
    }
  });

  it('a 429 retries with backoff and completes on attempt 3 (retry-429.json)', () => {
    const first = autoRetryDecision({ error: errorOf('provider', 'http_429'), attempt: 1, maxRetries: 2 });
    const second = autoRetryDecision({ error: errorOf('provider', 'http_429'), attempt: 2, maxRetries: 2 });

    expect(first).toMatchObject({ retry: true, nextAttempt: 2, delayMs: 500, repairPrompt: false });
    expect(second).toMatchObject({ retry: true, nextAttempt: 3, delayMs: 1_000 });
  });

  it('stops once the retry budget is spent', () => {
    const third = autoRetryDecision({ error: errorOf('provider'), attempt: 3, maxRetries: 2 });
    expect(third.retry).toBe(false);
    expect(third.reason).toContain('2 automatic retries');
  });

  it('a network error retries with the same backoff', () => {
    expect(autoRetryDecision({ error: errorOf('network'), attempt: 1, maxRetries: 3 })).toMatchObject({
      retry: true,
      mode: 'backoff',
      delayMs: 500,
    });
  });

  it('TC-ERR-006 an auth error makes exactly one attempt (mock-401)', () => {
    const decision = autoRetryDecision({ error: errorOf('auth'), attempt: 1, maxRetries: 5 });
    expect(decision.retry).toBe(false);
    expect(decision.mode).toBe('never');
    expect(decision.reason).toContain('auth');
  });

  it('never retries auth, invalid_config, workflow, guardrail or a cancellation', () => {
    for (const kind of ['auth', 'invalid_config', 'workflow', 'guardrail', 'user_cancelled'] as const) {
      expect(autoRetryDecision({ error: errorOf(kind), attempt: 1, maxRetries: 9 }).retry).toBe(false);
    }
  });

  it('an agent error gets one contract repair, with the prompt flagged for repair', () => {
    const first = autoRetryDecision({
      error: errorOf('agent', 'contract_violation'),
      attempt: 1,
      maxRetries: 5,
    });
    expect(first).toMatchObject({ retry: true, mode: 'contract_repair', delayMs: 0, repairPrompt: true });

    const second = autoRetryDecision({
      error: errorOf('agent', 'contract_violation'),
      attempt: 2,
      maxRetries: 5,
      contractRepairs: CONTRACT_REPAIR_RETRIES,
    });
    expect(second.retry).toBe(false);
    expect(second.reason).toContain('contract-repair');
  });

  it('the contract repair is spent regardless of how generous execution.retries is (D85)', () => {
    const decision = autoRetryDecision({
      error: errorOf('agent'),
      attempt: 7,
      maxRetries: 50,
      contractRepairs: 1,
    });
    expect(decision.retry).toBe(false);
  });

  it('a retry budget of 0 means no automatic retry at all', () => {
    expect(autoRetryDecision({ error: errorOf('provider'), attempt: 1, maxRetries: 0 }).retry).toBe(
      false,
    );
  });

  it('a fractional attempt is floored rather than producing a fractional wait', () => {
    const decision = autoRetryDecision({ error: errorOf('network'), attempt: 2.7, maxRetries: 4 });
    expect(decision).toMatchObject({ retry: true, nextAttempt: 3, delayMs: 1_000 });
  });
});
