import { WS_CLOSE_UNAUTHORIZED, WsClientFrameSchema, type Id } from '@ace/contracts';

import type { Logger } from '../logging/index.js';
import type { Auth, EngineEvent, Repository, Scope, Unsubscribe } from '../ports/index.js';
import type { EventBus } from './index.js';

/**
 * The bit of a WebSocket the hub needs. Keeping it this small is what lets `apps/server` pass a
 * real `ws` socket while tests pass a fake one and assert on the actual conversation.
 */
export interface HubSocket {
  send(data: string): void;
  close(code: number, reason?: string): void;
  on(event: 'message' | 'close', handler: (data: string) => void): void;
}

export interface WsHubDeps {
  bus: EventBus;
  repository: Repository;
  scope: Scope;
  auth: Auth;
  logger: Logger;
}

export interface WsHub {
  /** Called once per connection, with the token from `?token=`. */
  handleConnection(socket: HubSocket, token: string | undefined): Promise<void>;
  /** Connections currently attached — used by graceful shutdown. */
  closeAll(code?: number): void;
}

/** What one connected client is watching. */
interface Subscription {
  workflows: Set<Id>;
  engineScope: boolean;
}

/**
 * The WebSocket hub at `/ws` (§2.9, FR-SYS-002, FR-EXE-014).
 *
 * A connection is authenticated before anything is sent: a wrong or missing token is closed with
 * 4401 and never receives a frame (TC-SYS-003).
 */
export function createWsHub({ bus, repository, scope, auth, logger }: WsHubDeps): WsHub {
  const open = new Set<{ socket: HubSocket; unsubscribe: Unsubscribe }>();

  function wants(subscription: Subscription, event: EngineEvent): boolean {
    if (event.workflowId === undefined) return subscription.engineScope;
    return subscription.workflows.has(event.workflowId);
  }

  /**
   * A run or workflow frame carries the global `seq` alongside the payload (§2.9); that is the
   * number `resume { afterSeq }` is measured against.
   */
  function send(socket: HubSocket, event: EngineEvent): void {
    socket.send(JSON.stringify({ type: event.type, payload: event.payload, seq: event.seq }));
  }

  return {
    async handleConnection(socket, token) {
      if (!(await auth.verifyToken(scope, token))) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }

      const subscription: Subscription = { workflows: new Set(), engineScope: false };

      const unsubscribe = await bus.subscribe((event) => {
        if (wants(subscription, event)) send(socket, event);
      });
      const entry = { socket, unsubscribe };
      open.add(entry);

      socket.on('close', () => {
        unsubscribe();
        open.delete(entry);
      });

      socket.on('message', (raw) => {
        void handleFrame(raw);
      });

      // `hello` says where the log has got to, so a client knows what it would be resuming from.
      socket.send(
        JSON.stringify({ type: 'hello', payload: { seq: await repository.events.currentSeq(scope) } }),
      );

      async function handleFrame(raw: string): Promise<void> {
        let frame;
        try {
          frame = WsClientFrameSchema.parse(JSON.parse(raw));
        } catch {
          // A frame the contract does not define is ignored. Dropping the connection would punish
          // a client for a stray message it may not even have meant to send.
          logger.debug({ subsystem: 'ws' }, 'ignored an unrecognised client frame');
          return;
        }

        switch (frame.type) {
          case 'subscribe': {
            if (frame.payload.scope === 'workflow') subscription.workflows.add(frame.payload.id);
            else subscription.engineScope = true;
            return;
          }

          case 'unsubscribe': {
            if (frame.payload.scope === 'engine') subscription.engineScope = false;
            else if (frame.payload.id === undefined) subscription.workflows.clear();
            else subscription.workflows.delete(frame.payload.id);
            return;
          }

          case 'resume': {
            // Replay from the table, in seq order, for what this client is subscribed to — then
            // the live subscription above carries on from there (Arch §21.4).
            const missed = await repository.events.listAfter(scope, frame.payload.afterSeq, {
              workflowIds: [...subscription.workflows],
              includeEngineScope: subscription.engineScope,
            });
            for (const event of missed) send(socket, event);
            return;
          }
        }
      }
    },

    closeAll(code = 1001) {
      for (const { socket, unsubscribe } of open) {
        unsubscribe();
        socket.close(code, 'engine shutting down');
      }
      open.clear();
    },
  };
}
