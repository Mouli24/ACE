import type { ChatStreamStatus, StreamChatOptions } from '@ace/sdk';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDomainConversation } from './hooks';

/*
 * D336: the header's "live" pill shows only while the SSE stream is open, so the hook reports the
 * stream's status — and only the current stream's: a closed one still says `closed` after its
 * successor has opened.
 */

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';

interface FakeStream {
  options: StreamChatOptions;
  closed: boolean;
}

const streams: FakeStream[] = [];

vi.mock('../app/api', () => ({
  api: () => ({
    streamChat: (_runId: string, options: StreamChatOptions) => {
      const stream: FakeStream = { options, closed: false };
      streams.push(stream);
      options.onStatus?.('connecting');
      return {
        close: () => {
          stream.closed = true;
        },
        done: new Promise<void>(() => undefined),
        lastEventId: () => undefined,
        error: () => undefined,
      };
    },
  }),
}));

const report = (stream: FakeStream | undefined, status: ChatStreamStatus): void =>
  act(() => stream?.options.onStatus?.(status));

describe('useDomainConversation stream status', () => {
  beforeEach(() => {
    streams.length = 0;
  });

  it('follows the stream: connecting, open, reconnecting, open again', () => {
    const { result } = renderHook(() => useDomainConversation(RUN, { live: true }));
    expect(result.current.streamStatus).toBe('connecting');
    report(streams[0], 'open');
    expect(result.current.streamStatus).toBe('open');
    report(streams[0], 'reconnecting');
    expect(result.current.streamStatus).toBe('reconnecting');
    report(streams[0], 'open');
    expect(result.current.streamStatus).toBe('open');
  });

  it('a stream it closed no longer speaks for the page', () => {
    const { result, rerender } = renderHook(
      ({ node }: { node?: string }) =>
        useDomainConversation(RUN, { live: true, ...(node === undefined ? {} : { node }) }),
      { initialProps: {} },
    );
    report(streams[0], 'open');
    rerender({ node: '01ARZ3NDEKTSV4RRFFQ69G5N01' });
    expect(streams[0]?.closed).toBe(true);
    report(streams[1], 'open');
    report(streams[0], 'closed');
    expect(result.current.streamStatus).toBe('open');
  });

  it('a run that is not live has no stream and no status', () => {
    const { result } = renderHook(() => useDomainConversation(undefined, { live: false }));
    expect(streams).toHaveLength(0);
    expect(result.current.streamStatus).toBeUndefined();
  });
});
