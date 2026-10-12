import {
  ServerFrameSchema,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
  isPersistedFrame,
  type ServerFrame,
  type WsClientFrame,
  type WsSubscribePayload,
  type WsUnsubscribePayload,
} from '@ace/contracts';

/**
 * The WebSocket client for round 1 §2.9 and Arch §21.4.
 *
 * - `hello { seq }` on the first connection seeds `lastSeq`; on a reconnect it is ignored so the
 *   events missed while offline are not skipped.
 * - Round 2 adds the run and engine frames of §2.4 on the same socket: `ServerFrameSchema` covers
 *   the core, run and engine unions, and `isPersistedFrame` separates the ones that carry a seq
 *   from transient `node.token`.
 * - Every server frame with a `seq` at or below `lastSeq` is dropped, so a replay never delivers
 *   a frame twice; every accepted frame advances `lastSeq`.
 * - A drop (any close but our own, 4401 or 4403) schedules a reconnect with exponential backoff; once
 *   open it re-sends every active subscription, then `resume { afterSeq: lastSeq }`.
 */

export type AceSocketStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'
  | 'unauthorized'
  /** 4403: this page's origin is not on the engine's allow-list (FR-SYS-003, D301). */
  | 'forbidden_origin';

export type ServerFrameType = ServerFrame['type'];
export type ServerFrameOf<T extends ServerFrameType> = Extract<ServerFrame, { type: T }>;
export type FrameHandler<T extends ServerFrameType> = (
  payload: ServerFrameOf<T>['payload'],
  frame: ServerFrameOf<T>,
) => void;

export interface AceSocketOptions {
  /** `ws://127.0.0.1:4747/ws`; `?token=` is appended here. */
  url: string;
  token: string;
  /** Injectable for tests; defaults to the global `WebSocket`. */
  WebSocket?: typeof WebSocket;
  backoff?: { initialMs?: number; maxMs?: number };
}

export interface AceSocket {
  readonly status: AceSocketStatus;
  /** The highest seq accepted so far; `-1` before the first hello. */
  readonly lastSeq: number;
  connect(): void;
  close(): void;
  subscribe(payload: WsSubscribePayload): void;
  unsubscribe(payload: WsUnsubscribePayload): void;
  on<T extends ServerFrameType>(type: T, handler: FrameHandler<T>): () => void;
  onStatus(handler: (status: AceSocketStatus) => void): () => void;
}

const DEFAULT_INITIAL_MS = 500;
const DEFAULT_MAX_MS = 15_000;

/** Two subscriptions are the same when scope and id match; `engine` has no id. */
function subscriptionKey(payload: { scope: string; id?: string }): string {
  return payload.id === undefined ? payload.scope : `${payload.scope}:${payload.id}`;
}

export function createAceSocket(options: AceSocketOptions): AceSocket {
  const WS = options.WebSocket ?? globalThis.WebSocket;
  const initialMs = options.backoff?.initialMs ?? DEFAULT_INITIAL_MS;
  const maxMs = options.backoff?.maxMs ?? DEFAULT_MAX_MS;

  let ws: WebSocket | undefined;
  let status: AceSocketStatus = 'idle';
  let lastSeq = -1;
  let hadHello = false;
  let attempt = 0;
  let closedByClient = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const subscriptions = new Map<string, WsSubscribePayload>();
  const handlers = new Map<ServerFrameType, Set<FrameHandler<ServerFrameType>>>();
  const statusHandlers = new Set<(status: AceSocketStatus) => void>();

  function setStatus(next: AceSocketStatus): void {
    status = next;
    for (const handler of statusHandlers) handler(next);
  }

  function send(frame: WsClientFrame): void {
    if (ws && ws.readyState === WS.OPEN) ws.send(JSON.stringify(frame));
  }

  function dispatch(frame: ServerFrame): void {
    const set = handlers.get(frame.type);
    if (!set) return;
    for (const handler of set) handler(frame.payload, frame);
  }

  function handleMessage(data: unknown): void {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return;
    }
    const parsed = ServerFrameSchema.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;

    if (frame.type === 'hello') {
      if (!hadHello) {
        hadHello = true;
        lastSeq = Math.max(lastSeq, frame.payload.seq);
      }
      dispatch(frame);
      return;
    }

    // `node.token` is transient: it carries no seq, is never persisted and so is never replayed.
    // It must still be delivered, and it must not move the anchor `resume` asks from (§2.4).
    if (!isPersistedFrame(frame)) {
      dispatch(frame);
      return;
    }

    if (frame.seq <= lastSeq) return;
    lastSeq = frame.seq;
    dispatch(frame);
  }

  function scheduleReconnect(): void {
    const delay = Math.min(initialMs * 2 ** attempt, maxMs);
    attempt += 1;
    setStatus('reconnecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, delay);
  }

  function open(): void {
    const socket = new WS(`${options.url}?token=${encodeURIComponent(options.token)}`);
    ws = socket;
    if (status !== 'reconnecting') setStatus('connecting');

    socket.onopen = () => {
      if (ws !== socket) return;
      const resuming = hadHello;
      attempt = 0;
      setStatus('open');
      for (const payload of subscriptions.values()) send({ type: 'subscribe', payload });
      if (resuming) send({ type: 'resume', payload: { afterSeq: lastSeq } });
    };

    socket.onmessage = (event) => {
      if (ws !== socket) return;
      handleMessage(event.data);
    };

    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = undefined;
      if (closedByClient) {
        setStatus('closed');
        return;
      }
      if (event.code === WS_CLOSE_UNAUTHORIZED) {
        setStatus('unauthorized');
        return;
      }
      if (event.code === WS_CLOSE_FORBIDDEN_ORIGIN) {
        // Retrying cannot change the page's origin; say so instead.
        setStatus('forbidden_origin');
        return;
      }
      scheduleReconnect();
    };

    socket.onerror = () => {
      /* the close event that follows carries the decision */
    };
  }

  return {
    get status() {
      return status;
    },
    get lastSeq() {
      return lastSeq;
    },

    connect() {
      if (ws || reconnectTimer) return;
      closedByClient = false;
      open();
    },

    close() {
      closedByClient = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      const socket = ws;
      ws = undefined;
      socket?.close();
      setStatus('closed');
    },

    subscribe(payload) {
      subscriptions.set(subscriptionKey(payload), payload);
      send({ type: 'subscribe', payload });
    },

    unsubscribe(payload) {
      subscriptions.delete(subscriptionKey(payload));
      send({ type: 'unsubscribe', payload });
    },

    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      const generic = handler as unknown as FrameHandler<ServerFrameType>;
      set.add(generic);
      return () => {
        set.delete(generic);
      };
    },

    onStatus(handler) {
      statusHandlers.add(handler);
      return () => {
        statusHandlers.delete(handler);
      };
    },
  };
}
