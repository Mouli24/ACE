import {
  DomainChatPageSchema,
  DomainStreamFrameSchema,
  type DomainMessage,
  type DomainStreamFrame,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { routeApp, send } from '../../__tests__/route-app.js';
import { createRunDriverHarness } from '../../__tests__/run-driver-harness.js';
import { filterForNode } from '../project-chat.js';
import { createDomainRoutes } from '../routes.js';

/*
 * Domain Gate 5, the server half (D9, D314): the conversation is served in pages over HTTP and
 * streamed over SSE. A stream backfills, then goes live; its event id is the log's seq, so a
 * reconnect with Last-Event-ID carries on exactly where it stopped — nothing missed, nothing twice.
 */

interface Frame {
  id?: string;
  frame: DomainStreamFrame;
}

const API = 'http://127.0.0.1:4747/api/v1';

/** Reads SSE frames off a response until `done` says so, then cancels the stream. */
async function readFrames(
  response: Response,
  done: (frames: Frame[]) => boolean,
  timeoutMs = 4_000,
): Promise<Frame[]> {
  expect(response.headers.get('content-type')).toMatch(/text\/event-stream/u);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const frames: Frame[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (!done(frames)) {
      if (Date.now() > deadline) throw new Error(`timed out with ${frames.length} frames`);
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (next.done) continue;
      buffer += next.value;
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let id: string | undefined;
        let event = '';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (event === '') continue;
        frames.push({
          ...(id === undefined ? {} : { id }),
          frame: DomainStreamFrameSchema.parse({ event, data: JSON.parse(data.join('\n')) }),
        });
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

/** Folds frames into messages, as a client does: append adds, update replaces by id. */
function fold(frames: readonly Frame[], into = new Map<string, DomainMessage>()) {
  for (const { frame } of frames) {
    if (frame.event === 'chat.message' || frame.event === 'chat.update') {
      into.set(frame.data.message.id, frame.data.message);
    }
  }
  return into;
}

const appends = (frames: readonly Frame[]) =>
  frames.flatMap(({ frame }) => (frame.event === 'chat.message' ? [frame.data.message.id] : []));

async function parkedTeam() {
  const h = await createRunDriverHarness();
  const writer = h.agentNode('Writer');
  const review = h.agentNode('Review');
  await h.seed([writer, review], [h.edge(writer, review)]);
  const begun = await h.start({ domain: { stayOpen: true } });
  await h.waitForEvent('run.parked');
  const app = routeApp(createDomainRoutes(() => h.domain));
  const page = async (query = '') => {
    const response = await send(app, 'GET', `/runs/${begun.run.id}/chat${query}`);
    expect(response.status).toBe(200);
    return DomainChatPageSchema.parse(await response.json());
  };
  const stream = (query = '', headers: Record<string, string> = {}) =>
    app.request(`${API}/runs/${begun.run.id}/chat/stream${query}`, { headers });
  return { h, app, runId: begun.run.id, writer, review, page, stream };
}

describe('D314 GET /runs/:runId/chat', () => {
  it('pages forward with a cursor, never repeating or skipping a message', async () => {
    const { page } = await parkedTeam();
    const all = await page();
    expect(all.messages.length).toBeGreaterThan(4);
    expect(all.nextCursor).toBeUndefined();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const next = await page(`?limit=2${cursor === undefined ? '' : `&after=${cursor}`}`);
      seen.push(...next.messages.map((message) => message.id));
      if (next.nextCursor === undefined) break;
      cursor = next.nextCursor;
    }
    expect(seen).toEqual(all.messages.map((message) => message.id));
  });

  it("a lens is one node's view; a bad page is 400 and an unknown run 404", async () => {
    const { app, page, writer } = await parkedTeam();
    const lens = await page(`?node=${writer.id}`);
    expect(lens.messages.length).toBeGreaterThan(0);
    expect(filterForNode(lens.messages, writer.id)).toEqual(lens.messages);

    const runId = (await page()).messages[0]?.runId ?? '';
    expect((await send(app, 'GET', `/runs/${runId}/chat?limit=501`)).status).toBe(400);
    expect((await send(app, 'GET', '/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RNXX/chat')).status).toBe(404);
  });
});

describe('D314 GET /runs/:runId/chat/stream', () => {
  it('backfills the conversation, then sends what happens live, with the usage', async () => {
    const { h, runId, page, stream, writer } = await parkedTeam();
    const before = await page();
    const response = await stream();

    const posting = (async () => {
      // Once the backfill is in, the human speaks: it arrives live.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await h.post(runId, 'Writer, make it shorter');
    })();
    const frames = await readFrames(
      response,
      (seen) =>
        seen.some(
          ({ frame }) =>
            frame.event === 'chat.message' &&
            frame.data.message.type === 'agent' &&
            frame.data.message.author.nodeId === writer.id &&
            frame.data.message.turn?.trigger === 'instruction',
        ) &&
        seen.some(
          ({ frame }) =>
            frame.event === 'chat.update' &&
            frame.data.message.type === 'human' &&
            frame.data.message.delivery?.some((entry) => entry.state === 'DONE') === true,
        ),
    );
    await posting;

    // The backfill is the page, message for message.
    expect(appends(frames).slice(0, before.messages.length)).toEqual(
      before.messages.map((message) => message.id),
    );
    expect(frames.some(({ frame }) => frame.event === 'usage.snapshot')).toBe(true);
    const human = frames.find(
      ({ frame }) =>
        frame.event === 'chat.message' &&
        frame.data.message.type === 'human' &&
        frame.data.message.text === 'Writer, make it shorter',
    );
    expect(human).toBeDefined();
    // Its delivery moves as updates to that one message.
    expect(
      frames.some(
        ({ frame }) =>
          frame.event === 'chat.update' &&
          frame.data.message.id ===
            (human?.frame.event === 'chat.message' ? human.frame.data.message.id : '') &&
          frame.data.message.delivery?.some((entry) => entry.state !== 'PENDING'),
      ),
    ).toBe(true);
    // The turn's text streamed live as it was written, naming its speaker, with no id.
    const tokens = frames.filter(({ frame }) => frame.event === 'turn.token');
    expect(tokens.length).toBeGreaterThan(0);
    expect(
      tokens.every(
        ({ id, frame }) =>
          id === undefined && frame.event === 'turn.token' && frame.data.nodeId === writer.id,
      ),
    ).toBe(true);
    // Every id is a seq, and they only go up.
    const ids = frames.flatMap(({ id }) => (id === undefined ? [] : [Number(id)]));
    expect(ids.length).toBeGreaterThan(0);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('a reconnect with Last-Event-ID resumes after it: nothing missed, nothing twice', async () => {
    const { h, runId, page, stream } = await parkedTeam();
    const first = await readFrames(await stream(), (seen) => seen.length >= 3);
    const lastId = [...first].reverse().find(({ id }) => id !== undefined)?.id;
    expect(lastId).toBeDefined();

    await h.post(runId, 'Writer, again please');
    await h.waitForEvent('run.parked', 2);
    const now = await page();

    const second = await readFrames(
      await stream('', { 'Last-Event-ID': lastId ?? '' }),
      (seen) => fold([...first, ...seen]).size >= now.messages.length,
    );
    for (const { id } of second) {
      if (id !== undefined) expect(Number(id)).toBeGreaterThan(Number(lastId));
    }
    expect(appends(second).filter((id) => appends(first).includes(id))).toEqual([]);
    // The two streams together are the whole conversation, as it stands.
    const folded = fold([...first, ...second]);
    expect(now.messages.map((message) => folded.get(message.id))).toEqual(now.messages);

    // `?after=` is the same thing, for a client that cannot set the header.
    const viaQuery = await readFrames(
      await stream(`?after=${lastId}`),
      (seen) => fold([...first, ...seen]).size >= now.messages.length,
    );
    expect(appends(viaQuery)).toEqual(appends(second));
  });

  it("a lens stream carries that node's messages only; an unknown run is 404", async () => {
    const { app, stream, writer } = await parkedTeam();
    const frames = await readFrames(await stream(`?node=${writer.id}`), (seen) =>
      seen.some(({ frame }) => frame.event === 'usage.snapshot'),
    );
    const messages = [...fold(frames).values()];
    expect(messages.length).toBeGreaterThan(0);
    expect(filterForNode(messages, writer.id)).toEqual(messages);
    const missing = await app.request(`${API}/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RNXX/chat/stream`);
    expect(missing.status).toBe(404);
  });
});
