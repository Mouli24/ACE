import type { DomainMessage, DomainStreamFrame, DomainUsageSnapshot } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { AceApiError, createAceClient } from '../index.js';

/* Domain's client (D303, D310, D313, D314): pages, messages, routing, budget, usage, the stream. */

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const ENV = '01ARZ3NDEKTSV4RRFFQ69G5FE9';
const MSG = '01ARZ3NDEKTSV4RRFFQ69G5FM1';
const NOW = '2026-10-10T00:00:00.000Z';

const message = (seq: number, text = `m${seq}`): DomainMessage => ({
  id: `sys:${seq}.0`,
  runId: RUN,
  cursor: `${seq}.0`,
  author: { kind: 'system' },
  type: 'system',
  text,
  at: NOW,
});

const snapshot: DomainUsageSnapshot = {
  runId: RUN,
  budget: { limit: 1000, used: 10, level: 'OK' },
  total: { input: 6, output: 4, cachedInput: 0, estimatedShare: 0 },
  costEst: null,
  perNode: [],
  perTurn: [],
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(replies: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const next = replies.shift();
    if (next === undefined) {
      // Nothing more to say: a stream that stays open until the caller aborts.
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    }
    return next();
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** An SSE reply; it ends after these frames unless `stayOpen`. */
const sse =
  (text: string, stayOpen = false) =>
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          if (!stayOpen) controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

const frame = (seq: number, id = true) =>
  `event: chat.message\n${id ? `id: ${seq}\n` : ''}data: ${JSON.stringify({ message: message(seq) })}\n\n`;

describe('Domain over HTTP', () => {
  it('reads a page of the conversation, forward from a cursor, through a lens', async () => {
    const { calls, client } = recorder([json({ messages: [message(5)], nextCursor: '5.0' })]);
    const page = await client.chatPage(RUN, { node: NODE, after: '4.1', limit: 1 });
    expect(page.messages[0]?.text).toBe('m5');
    expect(calls[0]?.url).toBe(`http://x/api/v1/runs/${RUN}/chat?node=${NODE}&after=4.1&limit=1`);
  });

  it('posts a message, routes an envelope, sets the budget with PUT, and reads the usage', async () => {
    const { calls, client } = recorder([
      json({ messageId: MSG, delivery: [{ nodeId: NODE, state: 'PENDING' }] }, 201),
      json({ envelopeId: ENV, routing: 'EDITED' }),
      json(snapshot),
      json(snapshot),
    ]);
    expect(
      (await client.postRunMessage(RUN, { text: 'Writer, shorter', deliveryMode: 'interrupt' }))
        .messageId,
    ).toBe(MSG);
    expect(
      (await client.routeEnvelope(RUN, ENV, { decision: 'edit', edit: { summary: 'Shorter.' } }))
        .routing,
    ).toBe('EDITED');
    expect((await client.setRunBudget(RUN, 1000)).budget?.limit).toBe(1000);
    expect((await client.runUsage(RUN)).total.input).toBe(6);
    expect(
      calls.map((call) => `${call.method} ${call.url.replace('http://x/api/v1', '')}`),
    ).toEqual([
      `POST /runs/${RUN}/messages`,
      `POST /runs/${RUN}/envelopes/${ENV}/route`,
      `PUT /runs/${RUN}/budget`,
      `GET /runs/${RUN}/usage`,
    ]);
    expect(calls[2]?.body).toEqual({ limit: 1000 });
  });

  it('refuses a message the contract refuses before it is sent', async () => {
    const { calls, client } = recorder([]);
    await expect(client.postRunMessage(RUN, { text: '   ' })).rejects.toBeInstanceOf(AceApiError);
    expect(calls).toEqual([]);
  });
});

describe('D314 streamChat', () => {
  it('sends the token, reads frames, and reconnects from the last id it saw', async () => {
    const { calls, client } = recorder([
      sse(`${frame(10)}: keep-alive\n\n${frame(11)}`),
      sse(frame(12), true),
    ]);
    const frames: { frame: DomainStreamFrame; id: string | undefined }[] = [];
    const stream = client.streamChat(RUN, {
      node: NODE,
      retryMs: 1,
      onFrame: (each, id) => frames.push({ frame: each, id }),
    });
    await expect.poll(() => frames.length).toBe(3);
    stream.close();
    await stream.done;

    expect(frames.map(({ id }) => id)).toEqual(['10', '11', '12']);
    expect(calls[0]?.url).toBe(`http://x/api/v1/runs/${RUN}/chat/stream?node=${NODE}`);
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'Bearer t',
      accept: 'text/event-stream',
    });
    expect(calls[0]?.headers).not.toHaveProperty('last-event-id');
    expect(calls[1]?.headers).toMatchObject({ 'last-event-id': '11' });
    expect(stream.lastEventId()).toBe('12');
  });

  it('a frame without an id does not move the resume point; a frame it cannot read is skipped', async () => {
    const { client } = recorder([
      sse(`${frame(20)}event: chat.message\ndata: {"nope":true}\n\n${frame(21, false)}`, true),
    ]);
    const ids: (string | undefined)[] = [];
    const stream = client.streamChat(RUN, { onFrame: (_frame, id) => ids.push(id) });
    await expect.poll(() => ids.length).toBe(2);
    stream.close();
    await stream.done;
    expect(ids).toEqual(['20', undefined]);
    expect(stream.lastEventId()).toBe('20');
  });

  it('starts after the id it is given, and stops for good on a refusal', async () => {
    const statuses: string[] = [];
    const { calls, client } = recorder([
      json({ error: { code: 'not_found', message: 'no run' } }, 404),
    ]);
    const stream = client.streamChat(RUN, {
      after: '7',
      retryMs: 1,
      onFrame: () => undefined,
      onStatus: (status) => statuses.push(status),
    });
    await stream.done;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toMatchObject({ 'last-event-id': '7' });
    expect(statuses.at(-1)).toBe('closed');
    expect(stream.error()).toBeInstanceOf(AceApiError);
  });
});
