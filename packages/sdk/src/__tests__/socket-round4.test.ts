import type { WsServerFrame } from '@ace/contracts';

import { createAceSocket } from '../index.js';

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const TH = '01ARZ3NDEKTSV4RRFFQ69G5FD3';
const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const NODE_RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const MCP = '01ARZ3NDEKTSV4RRFFQ69G5FD1';
const CALL = '01ARZ3NDEKTSV4RRFFQ69G5FD5';
const MSG = '01ARZ3NDEKTSV4RRFFQ69G5FD2';
const NOW = '2026-09-29T00:00:00.000Z';

/** The socket test double from `socket.test.ts`, kept minimal for the round 4 frames. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: '' });
  }
  serverOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }
  serverSend(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

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
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

const chatToken = (delta: string) => ({ type: 'chat.token', payload: { threadId: TH, delta } });

const chatMessage = (seq: number) => ({
  type: 'chat.message',
  payload: {
    threadId: TH,
    message: {
      id: MSG,
      threadId: TH,
      role: 'agent',
      content: [{ type: 'text', text: 'hi' }],
      verdicts: [],
      at: NOW,
    },
  },
  seq,
});

const toolCall = (seq: number) => ({
  type: 'tool.call',
  payload: {
    runId: RUN,
    nodeRunId: NODE_RUN,
    toolCall: {
      id: CALL,
      nodeRunId: NODE_RUN,
      toolName: 'echo',
      args: { text: 'hi' },
      resultSummary: 'echo said: hi',
      durationMs: 3,
      status: 'ok',
      verdicts: [],
      at: NOW,
    },
  },
  seq,
});

const messageCreated = (seq: number) => ({
  type: 'message.created',
  payload: {
    workflowId: WF,
    message: {
      id: MSG,
      workflowId: WF,
      type: 'agent',
      content: [{ type: 'text', text: 'done' }],
      at: NOW,
    },
  },
  seq,
});

const mcpStatus = (seq: number) => ({
  type: 'mcp.status',
  payload: { serverId: MCP, status: 'connected', toolCount: 2 },
  seq,
});

describe('round 4 socket frames (§2.5, FR-TOOL-007/009, FR-CHAT-001/006)', () => {
  it('subscribes to a thread scope with its id', () => {
    const socket = makeSocket();
    socket.connect();
    latest().serverOpen();
    socket.subscribe({ scope: 'thread', id: TH });
    expect(latest().sent).toContainEqual({
      type: 'subscribe',
      payload: { scope: 'thread', id: TH },
    });
    socket.close();
  });

  it('dispatches every round 4 frame type to its handler', () => {
    const socket = makeSocket();
    const seen: string[] = [];
    for (const type of [
      'tool.call',
      'message.created',
      'chat.message',
      'chat.token',
      'mcp.status',
    ] as const) {
      socket.on(type, () => seen.push(type));
    }
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 0 } });
    latest().serverSend(toolCall(1));
    latest().serverSend(messageCreated(2));
    latest().serverSend(chatMessage(3));
    latest().serverSend(chatToken('delta'));
    latest().serverSend(mcpStatus(4));

    expect(seen).toEqual([
      'tool.call',
      'message.created',
      'chat.message',
      'chat.token',
      'mcp.status',
    ]);
    socket.close();
  });

  it('chat.token is transient (no seq) and chat.message advances the resume anchor', () => {
    const socket = makeSocket();
    const deltas: string[] = [];
    socket.on('chat.token', (payload) => deltas.push(payload.delta));
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 10 } });

    latest().serverSend(chatToken('a'));
    latest().serverSend(chatToken('b'));
    expect(socket.lastSeq).toBe(10);

    latest().serverSend(chatMessage(11));
    expect(socket.lastSeq).toBe(11);
    expect(deltas).toEqual(['a', 'b']);
    socket.close();
  });

  it('the persisted round 4 frames replay only once after a reconnect', () => {
    const socket = makeSocket();
    const calls: number[] = [];
    socket.on('tool.call', (_payload, frame) => calls.push(frame.seq));
    socket.subscribe({ scope: 'workflow', id: WF });
    socket.connect();
    latest().serverOpen();
    latest().serverSend({ type: 'hello', payload: { seq: 20 } });
    latest().serverSend(toolCall(21));
    expect(socket.lastSeq).toBe(21);

    // a replay re-sends 21: it must not reach the handler twice
    latest().serverSend(toolCall(21));
    latest().serverSend(toolCall(22) as unknown as WsServerFrame);
    expect(calls).toEqual([21, 22]);
    socket.close();
  });
});
