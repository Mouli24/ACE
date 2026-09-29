import type { ChatMessage, ServerFrame } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { ThreadEventBuffer } from '../thread-view.js';

const TH = '01ARZ3NDEKTSV4RRFFQ69G5FD3';
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FD9';
const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const NOW = '2026-09-29T00:00:00.000Z';

const token = (delta: string, threadId = TH): ServerFrame =>
  ({ type: 'chat.token', payload: { threadId, delta } }) as ServerFrame;

const message = (
  seq: number,
  role: ChatMessage['role'],
  text: string,
  threadId = TH,
): ServerFrame =>
  ({
    type: 'chat.message',
    payload: {
      threadId,
      message: {
        id: `01ARZ3NDEKTSV4RRFFQ69G5F${seq.toString().padStart(2, '0')}`,
        threadId,
        role,
        content: [{ type: 'text', text }],
        verdicts: [],
        at: NOW,
      },
    },
    seq,
  }) as ServerFrame;

describe('ThreadEventBuffer (round 4 §2.3/§2.5, FR-CHAT-004/006)', () => {
  it('accumulates chat.token deltas as the streaming reply, then settles on chat.message', () => {
    const buffer = new ThreadEventBuffer(TH);
    buffer.apply(message(1, 'user', 'hi'));
    buffer.apply(token('You '));
    buffer.apply(token('said: '));
    buffer.apply(token('hi'));

    expect(buffer.view.streaming).toBe(true);
    expect(buffer.view.streamingText).toBe('You said: hi');
    expect(buffer.view.messages.map((m) => m.role)).toEqual(['user']);

    buffer.apply(message(2, 'agent', 'You said: hi'));
    expect(buffer.view.streaming).toBe(false);
    expect(buffer.view.streamingText).toBe('');
    expect(buffer.view.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(buffer.view.lastSeq).toBe(2);
  });

  it('a user echo settling does not clear a reply already streaming', () => {
    const buffer = new ThreadEventBuffer(TH);
    buffer.apply(token('partial'));
    buffer.apply(message(1, 'user', 'hi'));
    expect(buffer.view.streaming).toBe(true);
    expect(buffer.view.streamingText).toBe('partial');
  });

  it('a replayed chat.message is folded only once (persisted, so resume re-sends it)', () => {
    const buffer = new ThreadEventBuffer(TH);
    buffer.apply(message(5, 'agent', 'once'));
    buffer.apply(message(5, 'agent', 'once'));
    expect(buffer.view.messages).toHaveLength(1);
    expect(buffer.view.lastSeq).toBe(5);
  });

  it('ignores frames for another thread and non-thread frames', () => {
    const buffer = new ThreadEventBuffer(TH);
    buffer.apply(token('mine'));
    buffer.apply(token('theirs', OTHER));
    buffer.apply(message(1, 'agent', 'theirs', OTHER));
    buffer.apply({
      type: 'node.token',
      payload: { runId: RUN, nodeRunId: NODE, delta: 'x' },
    } as ServerFrame);

    expect(buffer.view.streamingText).toBe('mine');
    expect(buffer.view.messages).toEqual([]);
  });

  it('learns its thread id from the first frame when not seeded', () => {
    const buffer = new ThreadEventBuffer();
    buffer.apply(token('hello', TH));
    buffer.apply(token('nope', OTHER));
    expect(buffer.view.threadId).toBe(TH);
    expect(buffer.view.streamingText).toBe('hello');
  });

  it('reset forgets everything', () => {
    const buffer = new ThreadEventBuffer(TH);
    buffer.apply(message(1, 'agent', 'hi'));
    buffer.apply(token('more'));
    buffer.reset();
    expect(buffer.view).toMatchObject({
      threadId: undefined,
      lastSeq: -1,
      messages: [],
      streamingText: '',
      streaming: false,
    });
  });
});
