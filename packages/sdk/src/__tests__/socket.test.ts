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

/* -------------------------------------------------------------------------- */
/* Round 2 — run and engine frames (§2.4)                                      */
/* -------------------------------------------------------------------------- */

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const NODE_RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FB2';

const nodeState = (seq: number, status: string) => ({
  type: 'node.state',
  payload: {
    runId: RUN,
    nodeRunId: NODE_RUN,
    nodeId: NODE,
    iteration: 1,
    attempt: 1,
    status,
  },
  seq,
});

const token = (delta: string) => ({
  type: 'node.token',
  payload: { runId: RUN, nodeRunId: NODE_RUN, delta },
});

describe('run-scope frames (round 2 §2.4)', () => {
  it('dispatches every run frame type to its handler', () => {
    const socket = makeSocket();
    const seen: string[] = [];
    for (const type of [
      'run.started',
      'node.state',
      'node.token',
      'node.output',
      'node.error',
      'edge.transfer',
      'usage.updated',
      'run.completed',
      'provider.status',
    ] as const) {
      socket.on(type, () => seen.push(type));
    }
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 0 } });
    latest().serverSend(nodeState(1, 'RUNNING') as never);
    latest().serverSend(token('he') as never);
    latest().serverSend({
      type: 'provider.status',
      payload: { providerId: NODE, status: 'CONNECTED' },
      seq: 2,
    } as never);
    expect(seen).toEqual(['node.state', 'node.token', 'provider.status']);
    socket.close();
  });

  it('`node.token` carries no seq, so it never moves the resume anchor (§2.4)', () => {
    const socket = makeSocket();
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 5 } });
    latest().serverSend(nodeState(6, 'RUNNING') as never);
    expect(socket.lastSeq).toBe(6);
    latest().serverSend(token('a') as never);
    latest().serverSend(token('b') as never);
    expect(socket.lastSeq).toBe(6);
    socket.close();
  });

  it('every streamed token is delivered, even though they share no seq', () => {
    const socket = makeSocket();
    const deltas: string[] = [];
    socket.on('node.token', (payload) => deltas.push(payload.delta));
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 0 } });
    for (const delta of ['Hel', 'lo ', 'wor', 'ld']) {
      latest().serverSend(token(delta) as never);
    }
    expect(deltas.join('')).toBe('Hello world');
    socket.close();
  });

  it('after a drop it resumes from the last persisted seq and replays run frames once', () => {
    const socket = makeSocket();
    const states: Array<{ status: string; seq: number }> = [];
    socket.on('node.state', (payload, frame) =>
      states.push({ status: payload.status, seq: frame.seq }),
    );
    socket.subscribe({ scope: 'workflow', id: WF });
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 10 } });
    latest().serverSend(nodeState(11, 'READY') as never);
    latest().serverSend(token('mid-stream') as never);
    latest().serverSend(nodeState(12, 'RUNNING') as never);

    latest().serverClose();
    vi.advanceTimersByTime(100);
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 20 } });
    expect(latest().sent).toContainEqual({ type: 'resume', payload: { afterSeq: 12 } });

    // the server replays from 12; 12 is a duplicate and must not be delivered twice
    latest().serverSend(nodeState(12, 'RUNNING') as never);
    latest().serverSend(nodeState(13, 'COMPLETED') as never);
    expect(states.map((s) => s.status)).toEqual(['READY', 'RUNNING', 'COMPLETED']);
    socket.close();
  });
});

/* -------------------------------------------------------------------------- */
/* Round 3 — control, approval, verdict and loop frames (§2.6)                 */
/* -------------------------------------------------------------------------- */

const REQUEST = '01ARZ3NDEKTSV4RRFFQ69G5FC2';
const VERDICT = '01ARZ3NDEKTSV4RRFFQ69G5FC3';
const LOOP_EDGE = '01ARZ3NDEKTSV4RRFFQ69G5FE2';
const AT = '2026-09-26T00:00:00.000Z';

const approvalRequest = {
  id: REQUEST,
  runId: RUN,
  nodeRunId: NODE_RUN,
  nodeId: NODE,
  nodeName: 'Reviewer',
  point: 'tool',
  checkType: 'destructive_action',
  reason: 'the tool would delete a folder',
  preview: 'rm -rf /tmp/demo',
  requestedAt: AT,
};

const verdict = {
  id: VERDICT,
  nodeRunId: NODE_RUN,
  point: 'output',
  checkType: 'pii',
  action: 'redact',
  passed: true,
  reason: 'one email address was redacted',
  redactedTypes: ['email'],
  at: AT,
};

describe('round 3 frames (§2.6, FR-CTL-001/002, FR-GRD-013/015, FR-PAR-005)', () => {
  it('dispatches all six new frame types to their handlers', () => {
    const socket = makeSocket();
    const seen: string[] = [];
    for (const type of [
      'run.paused',
      'run.resumed',
      'node.approval_required',
      'node.approval_decided',
      'guardrail.verdict',
      'loop.iteration',
    ] as const) {
      socket.on(type, () => seen.push(type));
    }
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 0 } });
    latest().serverSend({ type: 'run.paused', payload: { runId: RUN }, seq: 1 } as never);
    latest().serverSend({ type: 'run.resumed', payload: { runId: RUN }, seq: 2 } as never);
    latest().serverSend({
      type: 'node.approval_required',
      payload: { runId: RUN, request: approvalRequest },
      seq: 3,
    } as never);
    latest().serverSend({
      type: 'node.approval_decided',
      payload: {
        runId: RUN,
        nodeRunId: NODE_RUN,
        decision: { requestId: REQUEST, decision: 'approve', decidedAt: AT },
      },
      seq: 4,
    } as never);
    latest().serverSend({
      type: 'guardrail.verdict',
      payload: { runId: RUN, nodeRunId: NODE_RUN, verdict },
      seq: 5,
    } as never);
    latest().serverSend({
      type: 'loop.iteration',
      payload: { runId: RUN, edgeId: LOOP_EDGE, targetNodeId: NODE, iteration: 2 },
      seq: 6,
    } as never);

    expect(seen).toEqual([
      'run.paused',
      'run.resumed',
      'node.approval_required',
      'node.approval_decided',
      'guardrail.verdict',
      'loop.iteration',
    ]);
    socket.close();
  });

  it('the payload a handler receives is the typed one from the contract', () => {
    const socket = makeSocket();
    const redacted: string[] = [];
    const stops: Array<string | undefined> = [];
    const approvals: string[] = [];
    // These read `payload.verdict.redactedTypes`, `payload.stop` and `payload.request.nodeName`:
    // the frame union is what narrows them, so a wrong field would not compile.
    socket.on('guardrail.verdict', (payload) =>
      redacted.push(...(payload.verdict.redactedTypes ?? [])),
    );
    socket.on('loop.iteration', (payload) => stops.push(payload.stop));
    socket.on('node.approval_required', (payload) => approvals.push(payload.request.nodeName));

    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 0 } });
    latest().serverSend({
      type: 'guardrail.verdict',
      payload: { runId: RUN, nodeRunId: NODE_RUN, verdict },
      seq: 1,
    } as never);
    latest().serverSend({
      type: 'node.approval_required',
      payload: { runId: RUN, request: approvalRequest },
      seq: 2,
    } as never);
    latest().serverSend({
      type: 'loop.iteration',
      payload: {
        runId: RUN,
        edgeId: LOOP_EDGE,
        targetNodeId: NODE,
        iteration: 3,
        stop: 'max_iterations',
      },
      seq: 3,
    } as never);

    expect(redacted).toEqual(['email']);
    expect(approvals).toEqual(['Reviewer']);
    expect(stops).toEqual(['max_iterations']);
    socket.close();
  });

  it('all six are persisted, so they move the resume anchor and replay only once', () => {
    const socket = makeSocket();
    const verdicts: number[] = [];
    socket.on('guardrail.verdict', (_payload, frame) => verdicts.push(frame.seq));
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 40 } });
    latest().serverSend({ type: 'run.paused', payload: { runId: RUN }, seq: 41 } as never);
    latest().serverSend({
      type: 'guardrail.verdict',
      payload: { runId: RUN, nodeRunId: NODE_RUN, verdict },
      seq: 42,
    } as never);
    expect(socket.lastSeq).toBe(42);

    latest().serverClose();
    vi.advanceTimersByTime(100);
    latest().serverOpen();
    expect(latest().sent).toContainEqual({ type: 'resume', payload: { afterSeq: 42 } });
    // the replay includes 42 again: it must not reach the handler twice
    latest().serverSend({
      type: 'guardrail.verdict',
      payload: { runId: RUN, nodeRunId: NODE_RUN, verdict },
      seq: 42,
    } as never);
    expect(verdicts).toEqual([42]);
    socket.close();
  });

  it('a frame with a key the contract does not name is dropped, not half-applied', () => {
    const socket = makeSocket();
    const handler = vi.fn();
    socket.on('run.paused', handler);
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 0 } });
    latest().serverSend({ type: 'run.paused', payload: { runId: RUN, pausedAt: AT }, seq: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect(socket.lastSeq).toBe(0);
    socket.close();
  });
});
