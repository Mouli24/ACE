import { WS_CLOSE_UNAUTHORIZED, WsServerFrameSchema } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBatcher } from '../events/batcher.js';
import { createEventBus, type EventBus } from '../events/index.js';
import { createWsHub, type HubSocket, type WsHub } from '../events/ws-hub.js';
import { newId } from '../ids.js';
import { createLogger } from '../logging/index.js';
import { InProcessPubSubStub } from './pubsub-stub.js';
import { LOCAL_SCOPE, type Auth, type Scope } from '../ports/index.js';
import { FakeRepository } from './fake-repository.js';

const TOKEN = 'a'.repeat(64);
const scope = LOCAL_SCOPE;

const auth: Auth = {
  verifyToken: async (_s: Scope, token: string | undefined) => token === TOKEN,
};

/** A socket that records what the hub said to it, so a test can read the conversation. */
class FakeSocket implements HubSocket {
  readonly sent: string[] = [];
  closedWith: number | undefined;
  #handlers = new Map<string, (data: string) => void>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number): void {
    this.closedWith = code;
    this.#handlers.get('close')?.('');
  }

  on(event: 'message' | 'close', handler: (data: string) => void): void {
    this.#handlers.set(event, handler);
  }

  /** Drive a client → server frame. */
  async receive(frame: unknown): Promise<void> {
    this.#handlers.get('message')?.(JSON.stringify(frame));
    // Handlers are async; let the microtask queue drain before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  frames(): { type: string; payload: unknown; seq?: number }[] {
    return this.sent.map((line) => JSON.parse(line) as { type: string; payload: unknown });
  }
}

let repository: FakeRepository;
let bus: EventBus;
let hub: WsHub;

beforeEach(() => {
  repository = new FakeRepository();
  const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
  bus = createEventBus({
    repository,
    scope,
    pubsub: new InProcessPubSubStub(),
    now: () => '2026-09-21T10:00:00.000Z',
  });
  hub = createWsHub({ bus, repository, scope, auth, logger });
});

async function connect(token = TOKEN): Promise<FakeSocket> {
  const socket = new FakeSocket();
  await hub.handleConnection(socket, token);
  return socket;
}

describe('TC-SYS-003 WebSocket bad token', () => {
  it('closes a connection with the wrong token using 4401', async () => {
    const socket = await connect('wrong');

    expect(socket.closedWith).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(socket.sent).toEqual([]);
  });

  it('closes a connection with no token at all', async () => {
    const socket = new FakeSocket();
    await hub.handleConnection(socket, undefined);

    expect(socket.closedWith).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('greets a valid token with hello and the current global seq', async () => {
    const socket = await connect();

    expect(socket.closedWith).toBeUndefined();
    const hello = WsServerFrameSchema.parse(socket.frames()[0]);
    expect(hello.type).toBe('hello');
    expect(hello.type === 'hello' && hello.payload.seq).toBe(0);
  });

  it('reports the seq the log has already reached', async () => {
    await bus.emit({ type: 'workflow.updated', workflowId: newId(), payload: {} });

    const socket = await connect();
    const hello = WsServerFrameSchema.parse(socket.frames()[0]);

    expect(hello.type === 'hello' && hello.payload.seq).toBe(1);
  });
});

describe('FR-EXE-014 live delivery', () => {
  it('delivers workflow.updated only to a client subscribed to that workflow', async () => {
    const wanted = newId();
    const other = newId();

    const subscribed = await connect();
    await subscribed.receive({ type: 'subscribe', payload: { scope: 'workflow', id: wanted } });

    const bystander = await connect();
    await bystander.receive({ type: 'subscribe', payload: { scope: 'workflow', id: other } });

    await bus.emit({
      type: 'workflow.updated',
      workflowId: wanted,
      payload: { workflowId: wanted, version: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(subscribed.frames().map((f) => f.type)).toEqual(['hello', 'workflow.updated']);
    expect(bystander.frames().map((f) => f.type)).toEqual(['hello']);
  });

  it('carries the global seq on a workflow frame, which is what resume anchors to', async () => {
    const workflowId = newId();
    const socket = await connect();
    await socket.receive({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } });

    await bus.emit({
      type: 'workflow.updated',
      workflowId,
      payload: { workflowId, version: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frame = WsServerFrameSchema.parse(socket.frames()[1]);
    expect(frame.type).toBe('workflow.updated');
    expect(frame.type === 'workflow.updated' && frame.seq).toBe(1);
  });

  it('stops delivering after unsubscribe', async () => {
    const workflowId = newId();
    const socket = await connect();
    await socket.receive({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } });
    await socket.receive({ type: 'unsubscribe', payload: { scope: 'workflow', id: workflowId } });

    await bus.emit({ type: 'workflow.updated', workflowId, payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.frames().map((f) => f.type)).toEqual(['hello']);
  });

  it('ignores a frame it cannot parse rather than dropping the connection', async () => {
    const socket = await connect();
    await socket.receive({ type: 'nonsense' });

    expect(socket.closedWith).toBeUndefined();
  });
});

describe('FR-CHAT-006 thread subscription (round 4 §2.5)', () => {
  it('delivers a chat frame only to the thread it belongs to', async () => {
    const thread = newId();
    const otherThread = newId();

    const watcher = await connect();
    await watcher.receive({ type: 'subscribe', payload: { scope: 'thread', id: thread } });

    const otherWatcher = await connect();
    await otherWatcher.receive({ type: 'subscribe', payload: { scope: 'thread', id: otherThread } });

    // An engine-scope client must not see chat traffic, even though a chat frame carries no workflow.
    const engineWatcher = await connect();
    await engineWatcher.receive({ type: 'subscribe', payload: { scope: 'engine' } });

    await bus.emit({
      type: 'chat.message',
      payload: { threadId: thread, message: { id: newId() } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(watcher.frames().map((f) => f.type)).toEqual(['hello', 'chat.message']);
    expect(otherWatcher.frames().map((f) => f.type)).toEqual(['hello']);
    expect(engineWatcher.frames().map((f) => f.type)).toEqual(['hello']);
  });

  it('delivers a transient chat.token to the thread with no seq', async () => {
    const thread = newId();
    const socket = await connect();
    await socket.receive({ type: 'subscribe', payload: { scope: 'thread', id: thread } });

    await bus.emitTransient({ type: 'chat.token', payload: { threadId: thread, delta: 'hi' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const token = socket.frames().find((f) => f.type === 'chat.token');
    expect(token).toBeDefined();
    expect(token?.seq).toBeUndefined();
  });

  it('stops delivering after a thread unsubscribe', async () => {
    const thread = newId();
    const socket = await connect();
    await socket.receive({ type: 'subscribe', payload: { scope: 'thread', id: thread } });
    await socket.receive({ type: 'unsubscribe', payload: { scope: 'thread', id: thread } });

    await bus.emit({ type: 'chat.message', payload: { threadId: thread, message: { id: newId() } } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.frames().map((f) => f.type)).toEqual(['hello']);
  });

  it('resume replays a thread’s persisted chat.message and no other thread’s', async () => {
    const mine = newId();
    const theirs = newId();
    await bus.emit({ type: 'chat.message', payload: { threadId: theirs, message: { id: newId() } } });
    await bus.emit({ type: 'chat.message', payload: { threadId: mine, message: { id: newId() } } });

    const socket = await connect();
    await socket.receive({ type: 'subscribe', payload: { scope: 'thread', id: mine } });
    await socket.receive({ type: 'resume', payload: { afterSeq: 0 } });

    const replayed = socket.frames().filter((f) => f.type === 'chat.message');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.seq).toBe(2);
    expect((replayed[0]?.payload as { threadId: string }).threadId).toBe(mine);
  });
});

describe('FR-EXE-014 resume replays workflow.updated', () => {
  it('replays every missed event in order, then goes live', async () => {
    const workflowId = newId();

    // Three edits happen while the client is away.
    for (const version of [1, 2, 3]) {
      await bus.emit({
        type: 'workflow.updated',
        workflowId,
        payload: { workflowId, version },
      });
    }

    const socket = await connect();
    await socket.receive({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } });
    await socket.receive({ type: 'resume', payload: { afterSeq: 1 } });

    const replayed = socket.frames().filter((f) => f.type === 'workflow.updated');
    expect(replayed).toHaveLength(2);
    expect(replayed.map((f) => (f.payload as { version: number }).version)).toEqual([2, 3]);
    expect(replayed.map((f) => f.seq)).toEqual([2, 3]);

    // And it is live afterwards.
    await bus.emit({
      type: 'workflow.updated',
      workflowId,
      payload: { workflowId, version: 4 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.frames().filter((f) => f.type === 'workflow.updated')).toHaveLength(3);
  });

  it('replays nothing for a workflow the client is not subscribed to', async () => {
    const mine = newId();
    const theirs = newId();
    await bus.emit({ type: 'workflow.updated', workflowId: theirs, payload: {} });

    const socket = await connect();
    await socket.receive({ type: 'subscribe', payload: { scope: 'workflow', id: mine } });
    await socket.receive({ type: 'resume', payload: { afterSeq: 0 } });

    expect(socket.frames().filter((f) => f.type === 'workflow.updated')).toHaveLength(0);
  });

  it('replays nothing when the client is already up to date', async () => {
    const workflowId = newId();
    await bus.emit({ type: 'workflow.updated', workflowId, payload: {} });

    const socket = await connect();
    await socket.receive({ type: 'subscribe', payload: { scope: 'workflow', id: workflowId } });
    await socket.receive({ type: 'resume', payload: { afterSeq: 1 } });

    expect(socket.frames().filter((f) => f.type === 'workflow.updated')).toHaveLength(0);
  });

  it('persists every event, so a replay survives the client being gone (NFR-REL-01)', async () => {
    const workflowId = newId();
    await bus.emit({ type: 'workflow.updated', workflowId, payload: { version: 1 } });

    const stored = await repository.events.listAfter(scope, 0, { workflowIds: [workflowId] });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.seq).toBe(1);
  });
});

describe('Arch §24 token batching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collects pushes and flushes them together after the interval', () => {
    const flushed: string[][] = [];
    const batcher = createBatcher<string>({ intervalMs: 50, flush: (items) => flushed.push(items) });

    batcher.push('a');
    batcher.push('b');
    expect(flushed).toEqual([]);

    vi.advanceTimersByTime(50);
    expect(flushed).toEqual([['a', 'b']]);
  });

  it('starts a new window after each flush', () => {
    const flushed: string[][] = [];
    const batcher = createBatcher<string>({ intervalMs: 50, flush: (items) => flushed.push(items) });

    batcher.push('a');
    vi.advanceTimersByTime(50);
    batcher.push('b');
    vi.advanceTimersByTime(50);

    expect(flushed).toEqual([['a'], ['b']]);
  });

  it('never flushes an empty batch, so an idle stream costs nothing', () => {
    const flushed: string[][] = [];
    const batcher = createBatcher<string>({ intervalMs: 50, flush: (items) => flushed.push(items) });

    batcher.flush();
    vi.advanceTimersByTime(500);
    batcher.stop();

    expect(flushed).toEqual([]);
  });

  it('flushes what is pending on demand', () => {
    const flushed: string[][] = [];
    const batcher = createBatcher<string>({ intervalMs: 50, flush: (items) => flushed.push(items) });

    batcher.push('a');
    batcher.flush();

    expect(flushed).toEqual([['a']]);
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual([['a']]);
  });

  it('drops nothing when stopped, flushing what it still holds', () => {
    const flushed: string[][] = [];
    const batcher = createBatcher<string>({ intervalMs: 50, flush: (items) => flushed.push(items) });

    batcher.push('a');
    batcher.stop();

    expect(flushed).toEqual([['a']]);
  });
});

describe('D299 the project scope', () => {
  const silent = createLogger({ level: 'silent', destination: { write: () => undefined } });
  const PROJECT = newId();
  const OTHER = newId();
  const changed = (projectId: string) => ({
    type: 'files.changed',
    payload: { projectId, changes: [{ path: 'a.ts', kind: 'changed' }], resync: false },
  });
  const subscribe = (id: string) => ({ type: 'subscribe', payload: { scope: 'project', id } });

  it('delivers a project’s files.changed to its subscribers only, without a seq', async () => {
    const watching = await connect();
    const engineOnly = await connect();
    const other = await connect();
    await watching.receive(subscribe(PROJECT));
    await engineOnly.receive({ type: 'subscribe', payload: { scope: 'engine' } });
    await other.receive(subscribe(OTHER));

    await bus.emitTransient(changed(PROJECT));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(watching.frames().filter((f) => f.type === 'files.changed')).toEqual([changed(PROJECT)]);
    expect(engineOnly.frames().some((f) => f.type === 'files.changed')).toBe(false);
    expect(other.frames().some((f) => f.type === 'files.changed')).toBe(false);
  });

  it('asks for a watcher on the first subscriber and releases it after the last one leaves', async () => {
    const calls: Array<[string, boolean]> = [];
    hub = createWsHub({ bus, repository, scope, auth, logger: silent, onProjectWatch: (id, on) => calls.push([id, on]) });
    const a = await connect();
    const b = await connect();

    await a.receive(subscribe(PROJECT));
    await a.receive(subscribe(PROJECT));
    await b.receive(subscribe(PROJECT));
    expect(calls).toEqual([[PROJECT, true]]);

    await a.receive({ type: 'unsubscribe', payload: { scope: 'project', id: PROJECT } });
    expect(calls).toEqual([[PROJECT, true]]);

    b.close(1000);
    expect(calls).toEqual([
      [PROJECT, true],
      [PROJECT, false],
    ]);
  });

  it('closeAll releases every watched project exactly once', async () => {
    const calls: Array<[string, boolean]> = [];
    hub = createWsHub({ bus, repository, scope, auth, logger: silent, onProjectWatch: (id, on) => calls.push([id, on]) });
    const a = await connect();
    await a.receive(subscribe(PROJECT));
    await a.receive(subscribe(OTHER));

    hub.closeAll();

    expect(calls).toEqual([
      [PROJECT, true],
      [OTHER, true],
      [PROJECT, false],
      [OTHER, false],
    ]);
  });

  it('a throwing onProjectWatch never breaks the hub', async () => {
    const calls: boolean[] = [];
    hub = createWsHub({
      bus,
      repository,
      scope,
      auth,
      logger: silent,
      onProjectWatch: (_id, on) => {
        calls.push(on);
        throw new Error('watcher failed');
      },
    });
    const a = await connect();
    const b = await connect();
    await a.receive(subscribe(PROJECT));
    await b.receive(subscribe(PROJECT));

    expect(() => hub.closeAll()).not.toThrow();
    expect(a.closedWith).toBeDefined();
    expect(b.closedWith).toBeDefined();
    expect(calls).toEqual([true, false]);

    const c = await connect();
    await c.receive(subscribe(PROJECT));
    expect(calls).toEqual([true, false, true]);
  });
});
