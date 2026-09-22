import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  backoffDelayMs,
  createSemaphore,
} from '../providers/semaphore.js';

/** A promise plus the handle to settle it, so a test controls exactly when work finishes. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TC-PRV-009 a semaphore never lets more than its limit run at once', () => {
  it('runs a single call straight through', async () => {
    expect(await createSemaphore(1).run(async () => 'done')).toBe('done');
  });

  it('holds the third call back while two are in flight', async () => {
    const semaphore = createSemaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const calls = gates.map((gate, index) =>
      semaphore.run(async () => {
        started.push(index);
        await gate.promise;
      }),
    );

    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(semaphore.inFlight()).toBe(2);
    expect(semaphore.waiting()).toBe(1);

    gates[0]!.resolve();
    await calls[0];
    await Promise.resolve();

    expect(started).toEqual([0, 1, 2]);

    gates[1]!.resolve();
    gates[2]!.resolve();
    await Promise.all(calls);
    expect(semaphore.inFlight()).toBe(0);
  });

  it('never exceeds the limit across many short calls', async () => {
    const semaphore = createSemaphore(2);
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        semaphore.run(async () => {
          peak = Math.max(peak, semaphore.inFlight());
          await new Promise((resolve) => setTimeout(resolve, 1));
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });

  it('releases the slot when a call throws, so one failure cannot wedge the provider', async () => {
    const semaphore = createSemaphore(1);

    await expect(
      semaphore.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(semaphore.inFlight()).toBe(0);
    expect(await semaphore.run(async () => 'still works')).toBe('still works');
  });

  it('lets waiting calls through in the order they arrived', async () => {
    const semaphore = createSemaphore(1);
    const order: number[] = [];
    const gate = deferred();

    const first = semaphore.run(async () => {
      order.push(0);
      await gate.promise;
    });
    const rest = [1, 2, 3].map((index) =>
      semaphore.run(async () => {
        order.push(index);
      }),
    );

    gate.resolve();
    await Promise.all([first, ...rest]);

    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => createSemaphore(0)).toThrow(RangeError);
    expect(() => createSemaphore(1.5)).toThrow(RangeError);
  });
});

describe('Arch §28 backoff grows exponentially and is jittered', () => {
  it('doubles the ceiling with each attempt', () => {
    const full = { jitter: () => 1 };

    expect(backoffDelayMs(1, full)).toBe(DEFAULT_BACKOFF_BASE_MS);
    expect(backoffDelayMs(2, full)).toBe(DEFAULT_BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3, full)).toBe(DEFAULT_BACKOFF_BASE_MS * 4);
  });

  it('never waits longer than the cap', () => {
    expect(backoffDelayMs(50, { jitter: () => 1 })).toBe(DEFAULT_BACKOFF_MAX_MS);
  });

  it('spreads retries out, so a shared 429 does not resynchronise them', () => {
    expect(backoffDelayMs(3, { jitter: () => 0 })).toBe(0);
    expect(backoffDelayMs(3, { jitter: () => 0.5 })).toBe(DEFAULT_BACKOFF_BASE_MS * 2);
  });

  it('treats attempt 0 as the first attempt rather than going backwards', () => {
    expect(backoffDelayMs(0, { jitter: () => 1 })).toBe(DEFAULT_BACKOFF_BASE_MS);
  });
});
