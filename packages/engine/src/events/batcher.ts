export interface BatcherOptions<T> {
  /** Arch §24: stream tokens are batched for about 50 ms before they go to a client. */
  intervalMs: number;
  flush: (items: T[]) => void;
}

export interface Batcher<T> {
  push(item: T): void;
  /** Send whatever is pending now. */
  flush(): void;
  /** Stop the timer, flushing anything still held so nothing is dropped. */
  stop(): void;
}

/**
 * Collect items and hand them over in batches (Arch §24).
 *
 * Built now and deliberately unused: round 2's token streaming needs it, and building it here
 * means the timing rule has a test before anything depends on it. An empty window never fires, so
 * an idle stream costs nothing.
 */
export function createBatcher<T>({ intervalMs, flush }: BatcherOptions<T>): Batcher<T> {
  let pending: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0) return;

    const items = pending;
    pending = [];
    flush(items);
  };

  return {
    push(item) {
      pending.push(item);
      timer ??= setTimeout(send, intervalMs);
    },
    flush: send,
    stop: send,
  };
}
