import {
  WS_CLOSE_UNAUTHORIZED,
  WsClientFrameSchema,
  type WsServerFrame,
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
        this.unsubscribe = subscribeMockEvents((event) => this.deliver(event));
        this.onopen?.(new Event('open'));
        db.load();
        this.emit({ type: 'hello', payload: { seq: db.seq } });
      }, 0);
    }

    private emit(frame: WsServerFrame): void {
      if (this.readyState !== FakeWebSocket.OPEN) return;
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
    }

    private wants(event: MockEvent): boolean {
      return this.subscriptions.has(event.payload.workflowId);
    }

    private deliver(event: MockEvent): void {
      if (!this.wants(event)) return;
      this.emit({ type: event.type, payload: event.payload, seq: event.seq });
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
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.onclose?.(closeEvent(code, reason));
    }
  }

  return FakeWebSocket;
}
