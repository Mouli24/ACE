/** Retries an async operation with exponential backoff and jitter. */
export interface RetryOptions {
  maxAttempts: number;
  baseMs: number;
  jitterFactor: number;
}

// Wait longer after each failed attempt, and add randomness so callers do not stampede.
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
    const pauseMs = options.baseMs * 2 ** attempt;
    const extra = pauseMs * options.jitterFactor * Math.random();
    await new Promise((resolve) => setTimeout(resolve, pauseMs + extra));
  }
  throw lastError;
}
