import type { Readable, Writable } from 'node:stream';

/**
 * A JSON-RPC 2.0 connection over a language server's stdio, framed as LSP frames it: a
 * `Content-Length` header (in bytes), a blank line, then the JSON body.
 */
export interface RpcConnection {
  /** Rejects when `signal` aborts (the server is told `$/cancelRequest`) or the server goes. */
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown): void;
  /** What the server sends unasked: `textDocument/publishDiagnostics`, log lines, … */
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** What the server asks of us (`workspace/configuration`, …); a throw answers an error. */
  onRequest(handler: (method: string, params: unknown) => unknown): void;
  /** Every pending request rejects with `reason`; later calls reject at once. */
  close(reason: Error): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Message {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const HEADER_END = Buffer.from('\r\n\r\n');
const METHOD_NOT_FOUND = -32601;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export function connectRpc(input: Readable, output: Writable): RpcConnection {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed: Error | undefined;
  let buffer: Buffer = Buffer.alloc(0);
  let onNotification: (method: string, params: unknown) => void = () => undefined;
  let onRequest: (method: string, params: unknown) => unknown = (method) => {
    throw new RpcError(`${method} is not handled`, METHOD_NOT_FOUND);
  };

  const send = (message: object): void => {
    if (closed !== undefined) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  };

  const answer = (id: Message['id'], method: string, params: unknown): void => {
    Promise.resolve()
      .then(() => onRequest(method, params))
      .then(
        (result) => send({ id, result: result ?? null }),
        (error: unknown) =>
          send({
            id,
            error: {
              code: error instanceof RpcError ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
  };

  const dispatch = (message: Message): void => {
    if (message.method !== undefined) {
      if (message.id === undefined || message.id === null) {
        onNotification(message.method, message.params);
      } else {
        answer(message.id, message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiting = pending.get(message.id);
    if (waiting === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) {
      waiting.reject(new RpcError(message.error.message, message.error.code));
    } else {
      waiting.resolve(message.result ?? null);
    }
  };

  input.on('data', (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf(HEADER_END);
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const length = /content-length:\s*(\d+)/i.exec(header)?.[1];
      if (length === undefined) {
        // Not a frame we can read: drop the header and look for the next one.
        buffer = buffer.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      const start = headerEnd + HEADER_END.length;
      const end = start + Number(length);
      if (buffer.length < end) return;
      const body = buffer.subarray(start, end).toString('utf8');
      buffer = buffer.subarray(end);
      try {
        dispatch(JSON.parse(body) as Message);
      } catch {
        // A body that is not JSON is skipped; the next frame is still read.
      }
    }
  });

  return {
    request(method, params, signal) {
      if (closed !== undefined) return Promise.reject(closed);
      if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const onAbort = (): void => {
          if (!pending.delete(id)) return;
          send({ method: '$/cancelRequest', params: { id } });
          reject(signal?.reason as Error);
        };
        pending.set(id, {
          resolve: (value) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
          },
          reject: (error) => {
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send({ method, params });
    },
    onNotification(handler) {
      onNotification = handler;
    },
    onRequest(handler) {
      onRequest = handler;
    },
    close(reason) {
      if (closed !== undefined) return;
      closed = reason;
      for (const waiting of pending.values()) waiting.reject(reason);
      pending.clear();
    },
  };
}
