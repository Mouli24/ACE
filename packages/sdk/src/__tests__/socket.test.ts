import { WS_CLOSE_UNAUTHORIZED, type WsServerFrame } from '@ace/contracts';

import { createAceSocket, type AceSocketStatus } from '../index.js';

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** A WebSocket double: the test drives open/message/close from the server side. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closedByClient: number | undefined;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('not open');
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.closedByClient = code ?? 1000;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: '' });
  }

  /* server side */
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  serverSend(frame: WsServerFrame | Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code = 1006): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: '' });
  }
}

const updated = (seq: number, version = seq): WsServerFrame => ({
  type: 'workflow.updated',
  payload: { workflowId: WF, version },
  seq,
});

function latest(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error('no socket');
  return ws;
}

function makeSocket() {
  return createAceSocket({
    url: 'ws://127.0.0.1:4747/ws',
    token: 'tok',
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    backoff: { initialMs: 100, maxMs: 1000 },
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createAceSocket (round 1 §2.9, FR-EXE-014, Arch §21.4)', () => {
  it('connects to the ws url with the token as a query param', () => {
    const socket = makeSocket();
    socket.connect();
    expect(latest().url).toBe('ws://127.0.0.1:4747/ws?token=tok');
    socket.close();
  });

  it('records the seq from hello and sends subscribe frames once open', () => {
    const socket = makeSocket();
    socket.connect();
    socket.subscribe({ scope: 'workflow', id: WF });
    expect(latest().sent).toEqual([]);

    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 7 } });

    expect(socket.lastSeq).toBe(7);
    expect(latest().sent).toEqual([{ type: 'subscribe', payload: { scope: 'workflow', id: WF } }]);
    socket.close();
  });

  it('dispatches typed frames to on() handlers and advances lastSeq', () => {
    const socket = makeSocket();
    const seen: number[] = [];
    socket.on('workflow.updated', (payload, frame) => {
      expect(payload.workflowId).toBe(WF);
      seen.push(frame.seq);
    });
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 0 } });
    latest().serverSend(updated(1));
    latest().serverSend(updated(2));

    expect(seen).toEqual([1, 2]);
    expect(socket.lastSeq).toBe(2);
    socket.close();
  });

  it('ignores frames that do not match the contract', () => {
    const socket = makeSocket();
    const handler = vi.fn();
    socket.on('workflow.updated', handler);
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'workflow.updated', payload: { nope: 1 } });
    latest().onmessage?.({ data: 'not json' });
    expect(handler).not.toHaveBeenCalled();
    socket.close();
  });

  it('reconnects with exponential backoff, re-subscribes, then resumes after the last seq', () => {
    const socket = makeSocket();
    const statuses: AceSocketStatus[] = [];
    socket.onStatus((s) => statuses.push(s));
    socket.subscribe({ scope: 'workflow', id: WF });
    socket.subscribe({ scope: 'engine' });
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 10 } });
    latest().serverSend(updated(11));
    latest().serverSend(updated(12));
    expect(FakeWebSocket.instances).toHaveLength(1);

    latest().serverClose();
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(99);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // second drop before open: backoff doubles
    latest().serverClose();
    vi.advanceTimersByTime(199);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 20 } });

    expect(latest().sent).toEqual([
      { type: 'subscribe', payload: { scope: 'workflow', id: WF } },
      { type: 'subscribe', payload: { scope: 'engine' } },
      { type: 'resume', payload: { afterSeq: 12 } },
    ]);
    // the reconnect hello must not move lastSeq past the events we have not seen
    expect(socket.lastSeq).toBe(12);
    expect(statuses.at(-1)).toBe('open');
    socket.close();
  });

  it('delivers every replayed frame exactly once, in order, with no duplicates', () => {
    const socket = makeSocket();
    const seen: number[] = [];
    socket.on('workflow.updated', (_p, f) => seen.push(f.seq));
    socket.subscribe({ scope: 'workflow', id: WF });
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 0 } });
    latest().serverSend(updated(1));
    latest().serverSend(updated(2));
    latest().serverClose();
    vi.advanceTimersByTime(100);
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 5 } });
    // the server replays from afterSeq=2, but a sloppy server might re-send 2 as well
    latest().serverSend(updated(2));
    latest().serverSend(updated(3));
    latest().serverSend(updated(4));
    latest().serverSend(updated(5));
    latest().serverSend(updated(5));

    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(socket.lastSeq).toBe(5);
    socket.close();
  });

  it('resets the backoff after a successful open', () => {
    const socket = makeSocket();
    socket.connect();
    latest().serverOpen();
    latest().serverClose();
    vi.advanceTimersByTime(100);
    latest().serverClose();
    vi.advanceTimersByTime(200);
    latest().serverOpen();
    latest().serverClose();
    vi.advanceTimersByTime(100);
    expect(FakeWebSocket.instances).toHaveLength(4);
    socket.close();
  });

  it('caps the backoff at maxMs', () => {
    const socket = makeSocket();
    socket.connect();
    for (let i = 0; i < 6; i += 1) {
      latest().serverClose();
      vi.advanceTimersByTime(1000);
    }
    expect(FakeWebSocket.instances).toHaveLength(7);
    socket.close();
  });

  it('does not reconnect after close code 4401 and reports unauthorized', () => {
    const socket = makeSocket();
    const statuses: AceSocketStatus[] = [];
    socket.onStatus((s) => statuses.push(s));
    socket.connect();
    latest().serverClose(WS_CLOSE_UNAUTHORIZED);
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses.at(-1)).toBe('unauthorized');
  });

  it('does not reconnect after the client closes, and unsubscribe sends a frame', () => {
    const socket = makeSocket();
    socket.connect();
    latest().serverOpen();
    socket.subscribe({ scope: 'workflow', id: WF });
    socket.unsubscribe({ scope: 'workflow', id: WF });
    expect(latest().sent).toEqual([
      { type: 'subscribe', payload: { scope: 'workflow', id: WF } },
      { type: 'unsubscribe', payload: { scope: 'workflow', id: WF } },
    ]);
    socket.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.status).toBe('closed');
  });

  it('on() returns an unsubscribe function', () => {
    const socket = makeSocket();
    const handler = vi.fn();
    const off = socket.on('workflow.updated', handler);
    socket.connect();
    latest().serverOpen();
    latest().serverSend(updated(1));
    off();
    latest().serverSend(updated(2));
    expect(handler).toHaveBeenCalledTimes(1);
    socket.close();
  });
});
