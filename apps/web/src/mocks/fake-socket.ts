import {
  WS_CLOSE_UNAUTHORIZED,
  WsClientFrameSchema,
  type ServerFrame,
  type WsSubscribePayload,
} from '@ace/contracts';

import type { MockDb, MockEvent } from './db';
import { subscribeMockEvents } from './event-bus';

/**
 * A `WebSocket` stand-in for mock mode (round 1 §5 step 10): the server side of §2.9 in the
 * browser. It sends `hello { seq }` on open, delivers `workflow.updated` for subscribed
 * workflows, replays persisted events on `resume { afterSeq }`, and closes with 4401 when the
 * token is missing. The SDK client talks to it exactly as it would to the engine.
 */

export interface FakeWebSocketInstance {
  readonly url: string;
  readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent<string>) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Test control: drop the connection as if the engine had gone away. */
  serverClose(code?: number): void;
}

export interface FakeWebSocketClass {
  new (url: string | URL): FakeWebSocketInstance;
  readonly instances: FakeWebSocketInstance[];
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}

function closeEvent(code: number, reason = ''): CloseEvent {
  if (typeof CloseEvent === 'function') return new CloseEvent('close', { code, reason });
  return Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 }) as CloseEvent;
}

/**
 * Every open fake socket, so a scenario (or a test) can drop the connection the way an engine
 * restart would and watch the SDK reconnect and `resume` (FR-EXE-014, TC-EXE-013).
 */
const live = new Set<FakeWebSocketInstance>();

export function dropMockSockets(code = 1006): void {
  for (const socket of [...live]) socket.serverClose(code);
}

export function createFakeWebSocket(db: MockDb): FakeWebSocketClass {
  const instances: FakeWebSocketInstance[] = [];

  class FakeWebSocket implements FakeWebSocketInstance {
    static readonly instances = instances;
    static readonly CONNECTING = 0 as const;
    static readonly OPEN = 1 as const;
    static readonly CLOSING = 2 as const;
    static readonly CLOSED = 3 as const;

    readonly url: string;
    readyState: number = FakeWebSocket.CONNECTING;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent<string>) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;

    private subscriptions = new Set<string>();
    private engineScope = false;
    private unsubscribe: (() => void) | undefined;

    constructor(url: string | URL) {
      this.url = String(url);
      instances.push(this);
      const token = new URL(this.url, 'http://localhost').searchParams.get('token');
      setTimeout(() => {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        if (!token) {
          this.finish(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
          return;
        }
        this.readyState = FakeWebSocket.OPEN;
        live.add(this);
        this.unsubscribe = subscribeMockEvents((event) => this.deliver(event));
        this.onopen?.(new Event('open'));
        db.load();
        this.emit({ type: 'hello', payload: { seq: db.seq } });
      }, 0);
    }

    private emit(frame: ServerFrame): void {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
    }

    /**
     * §2.4/round 4 §2.5: a workflow subscription delivers `workflow.updated` and every run event of
     * that workflow's runs; a thread subscription delivers that thread's `chat.token`/`chat.message`;
     * `provider.status` and `mcp.status` are engine scope. A thread id and a workflow id both live in
     * `subscriptions`, so the scope is what tells them apart.
     */
    private wants(event: MockEvent): boolean {
      if (event.scope === 'engine') return this.engineScope;
      if (event.scope === 'thread') {
        return event.threadId !== undefined && this.subscriptions.has(event.threadId);
      }
      return event.workflowId !== undefined && this.subscriptions.has(event.workflowId);
    }

    private deliver(event: MockEvent): void {
      if (!this.wants(event)) return;
      const frame = {
        type: event.type,
        payload: event.payload,
        ...(event.seq === undefined ? {} : { seq: event.seq }),
      } as ServerFrame;
      this.emit(frame);
    }

    send(data: string): void {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error('InvalidStateError: not open');
      const parsed = WsClientFrameSchema.safeParse(JSON.parse(data));
      if (!parsed.success) return;
      const frame = parsed.data;
      switch (frame.type) {
        case 'subscribe':
          this.addSubscription(frame.payload);
          break;
        case 'unsubscribe':
          if (frame.payload.scope === 'engine') this.engineScope = false;
          else if (frame.payload.id) this.subscriptions.delete(frame.payload.id);
          break;
        case 'resume':
          db.load();
          for (const event of db.eventsAfter(frame.payload.afterSeq)) this.deliver(event);
          break;
      }
    }

    private addSubscription(payload: WsSubscribePayload): void {
      if (payload.scope === 'engine') this.engineScope = true;
      else this.subscriptions.add(payload.id);
    }

    close(code = 1000, reason = ''): void {
      this.finish(code, reason);
    }

    serverClose(code = 1006): void {
      this.finish(code, 'server closed');
    }

    private finish(code: number, reason: string): void {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      live.delete(this);
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.onclose?.(closeEvent(code, reason));
    }
  }

  return FakeWebSocket;
}
