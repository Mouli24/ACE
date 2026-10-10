import {
  API_BASE_PATH,
  DomainStreamFrameSchema,
  type DomainStreamFrame,
  type Id,
} from '@ace/contracts';

import { AceApiError } from './errors.js';
import { createSseParser } from './sse-parse.js';

/**
 * Domain's live conversation (D314): `GET /runs/:runId/chat/stream`, read with `fetch` so the
 * Bearer token can travel, and reconnected — with `Last-Event-ID`, the seq of the last frame that
 * carried one — whenever the connection drops. The server resumes after that seq, so a reconnect
 * misses nothing and repeats nothing. A refusal (a 4xx: no such run, a bad query) ends it for good.
 */

export type ChatStreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface StreamChatOptions {
  /** A lens (D5): only this node's messages. */
  node?: Id;
  /** Resume after this id — the last one a previous stream saw. */
  after?: string;
  onFrame(frame: DomainStreamFrame, id: string | undefined): void;
  onStatus?(status: ChatStreamStatus): void;
  /** The wait before a reconnect. */
  retryMs?: number;
  signal?: AbortSignal;
}

export interface ChatStream {
  close(): void;
  /** Settles once the stream has stopped for good — closed, or refused. */
  done: Promise<void>;
  /** The id a reconnect resumes after. */
  lastEventId(): string | undefined;
  /** Why it stopped, when it was refused. */
  error(): AceApiError | undefined;
}

export const STREAM_RETRY_MS = 2_000;

interface StreamTransport {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
}

export function openChatStream(
  transport: StreamTransport,
  runId: Id,
  options: StreamChatOptions,
): ChatStream {
  const controller = new AbortController();
  const signal = controller.signal;
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let lastId = options.after;
  let refusal: AceApiError | undefined;

  const url = new URL(
    `${transport.baseUrl.replace(/\/+$/u, '')}${API_BASE_PATH}/runs/${runId}/chat/stream`,
  );
  if (options.node !== undefined) url.searchParams.set('node', options.node);

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  async function connectOnce(): Promise<void> {
    const response = await transport.fetch(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${transport.token}`,
        accept: 'text/event-stream',
        ...(lastId === undefined ? {} : { 'last-event-id': lastId }),
      },
      signal,
    });
    if (!response.ok) {
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        json = undefined;
      }
      throw AceApiError.fromResponse(response.status, json);
    }
    if (response.body === null) return;
    options.onStatus?.('open');

    const parser = createSseParser((event) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = DomainStreamFrameSchema.safeParse({ event: event.event, data });
      if (!parsed.success) return;
      if (event.id !== undefined) lastId = event.id;
      options.onFrame(parsed.data, event.id);
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Closing cuts the read short even where the body does not follow the fetch's signal.
    const cancel = (): void => void reader.cancel().catch(() => undefined);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.feed(decoder.decode());
    } finally {
      signal.removeEventListener('abort', cancel);
      parser.end();
      reader.releaseLock();
    }
  }

  const done = (async () => {
    options.onStatus?.('connecting');
    while (!signal.aborted) {
      try {
        await connectOnce();
      } catch (error) {
        if (signal.aborted) break;
        // A refusal is final; a dropped connection or a server error is worth another try.
        if (error instanceof AceApiError && error.status >= 400 && error.status < 500) {
          refusal = error;
          break;
        }
      }
      if (signal.aborted) break;
      options.onStatus?.('reconnecting');
      await wait(options.retryMs ?? STREAM_RETRY_MS);
    }
    options.onStatus?.('closed');
  })();

  return {
    close: () => controller.abort(),
    done,
    lastEventId: () => lastId,
    error: () => refusal,
  };
}
