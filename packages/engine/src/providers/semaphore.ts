/**
 * Per-provider concurrency and backoff (FR-PRV-009, Arch §11 rate limiting, Arch §14.2).
 *
 * A provider is a shared, rate-limited resource: five parallel agent nodes on one key are five
 * parallel calls unless something holds them back. `Semaphore` is that something, and the engine
 * keeps one per provider so a slow local model cannot starve a cloud one.
 */

export interface Semaphore {
  /** Runs `fn` when a slot is free, and releases the slot however `fn` ends. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** How many slots are in use right now — the number TC-PRV-009 watches. */
  inFlight(): number;
  waiting(): number;
  readonly limit: number;
}

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`A concurrency limit must be a positive integer, got ${limit}.`);
  }

  let active = 0;
  const queue: (() => void)[] = [];

  const release = (): void => {
    // FIFO: the call that has been waiting longest goes next, so nothing can be starved. The slot
    // is handed to it directly rather than freed: freeing it first left a gap before the waiter
    // woke in which a newcomer could take the slot as well (D-027).
    const next = queue.shift();
    if (next === undefined) active -= 1;
    else next();
  };

  return {
    limit,
    inFlight: () => active,
    waiting: () => queue.length,

    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        // Woken by `release`, which passes its slot on: `active` already counts this call.
        await new Promise<void>((resolve) => queue.push(resolve));
      } else {
        active += 1;
      }

      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Backoff                                                                     */
/* -------------------------------------------------------------------------- */

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Injected so a test does not have to wait out a real delay. */
  jitter?: () => number;
}

export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;

/**
 * Exponential backoff with full jitter (Arch §28: provider and network errors retry with
 * backoff). Jitter matters more than the curve: without it every node that hit the same 429
 * retries at the same instant and reproduces the burst that caused it.
 *
 * `attempt` is 1-based, so the first wait is around `baseMs`.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const jitter = options.jitter ?? Math.random;

  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * jitter());
}
