import {
  PROJECT_EVENT_TYPES,
  THREAD_EVENT_TYPES,
  WS_CLOSE_UNAUTHORIZED,
  WsClientFrameSchema,
  type Id,
} from '@ace/contracts';

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
  /**
   * D299: told when a project gains its first `project`-scope subscriber across every connection
   * (`true`) and when it loses its last (`false`), so its folder is watched only while someone
   * looks at it.
   */
  onProjectWatch?: (projectId: Id, watched: boolean) => void;
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
  /** The direct-chat threads this client is watching (round 4 §2.5, FR-CHAT-006). */
  threads: Set<Id>;
  /** Projects whose files.changed this client gets (D299). */
  projects: Set<Id>;
  engineScope: boolean;
}

/** The event types that ride a `thread` subscription, matched by `payload.threadId`. */
const THREAD_TYPES = new Set<string>(THREAD_EVENT_TYPES);

/** The event types that ride a `project` subscription, matched by `payload.projectId` (D299). */
const PROJECT_TYPES = new Set<string>(PROJECT_EVENT_TYPES);

/**
 * The WebSocket hub at `/ws` (§2.9, FR-SYS-002, FR-EXE-014).
 *
 * A connection is authenticated before anything is sent: a wrong or missing token is closed with
 * 4401 and never receives a frame (TC-SYS-003).
 */
export function createWsHub({
  bus,
  repository,
  scope,
  auth,
  logger,
  onProjectWatch,
}: WsHubDeps): WsHub {
  const open = new Set<{
    socket: HubSocket;
    unsubscribe: Unsubscribe;
    subscription: Subscription;
  }>();

  /** How many connections watch each project; the watcher's life follows 0 ↔ 1 (D299). */
  const projectWatchers = new Map<Id, number>();

  function retain(projectId: Id): void {
    const count = projectWatchers.get(projectId) ?? 0;
    projectWatchers.set(projectId, count + 1);
    if (count === 0) onProjectWatch?.(projectId, true);
  }

  function release(projectId: Id): void {
    const count = projectWatchers.get(projectId) ?? 0;
    if (count > 1) {
      projectWatchers.set(projectId, count - 1);
      return;
    }
    projectWatchers.delete(projectId);
    if (count === 1) onProjectWatch?.(projectId, false);
  }

  /** Idempotent: the set is emptied first, so a second call (close after closeAll) releases nothing. */
  function releaseAll(subscription: Subscription): void {
    const projects = [...subscription.projects];
    subscription.projects.clear();
    for (const projectId of projects) release(projectId);
  }

  function wants(subscription: Subscription, event: EngineEvent): boolean {
    // Forge's frames belong to their project and nowhere else (D299), matched by payload.projectId.
    if (PROJECT_TYPES.has(event.type)) {
      const projectId = (event.payload as { projectId?: Id }).projectId;
      return projectId !== undefined && subscription.projects.has(projectId);
    }
    // A chat frame belongs to its thread and nowhere else (round 4 §2.5): it routes by
    // `payload.threadId` to that thread's subscribers, never to the engine or a workflow scope, so
    // an open chat panel gets `chat.token`/`chat.message` without any of the run's traffic.
    if (THREAD_TYPES.has(event.type)) {
      const threadId = (event.payload as { threadId?: Id }).threadId;
      return threadId !== undefined && subscription.threads.has(threadId);
    }
    if (event.workflowId === undefined) return subscription.engineScope;
    return subscription.workflows.has(event.workflowId);
  }

  /**
   * A run or workflow frame carries the global `seq` alongside the payload (§2.9); that is the
   * number `resume { afterSeq }` is measured against. A transient frame carries none, because it
   * was never written down and cannot be replayed (round 2 §2.4).
   */
  function send(socket: HubSocket, event: EngineEvent): void {
    socket.send(
      JSON.stringify(
        event.transient === true
          ? { type: event.type, payload: event.payload }
          : { type: event.type, payload: event.payload, seq: event.seq },
      ),
    );
  }

  return {
    async handleConnection(socket, token) {
      if (!(await auth.verifyToken(scope, token))) {
        socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }

      const subscription: Subscription = {
        workflows: new Set(),
        threads: new Set(),
        projects: new Set(),
        engineScope: false,
      };

      const unsubscribe = await bus.subscribe((event) => {
        if (wants(subscription, event)) send(socket, event);
      });
      const entry = { socket, unsubscribe, subscription };
      open.add(entry);

      socket.on('close', () => {
        unsubscribe();
        releaseAll(subscription);
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
            const payload = frame.payload;
            if (payload.scope === 'workflow') subscription.workflows.add(payload.id);
            else if (payload.scope === 'thread') subscription.threads.add(payload.id);
            else if (payload.scope === 'project') {
              if (!subscription.projects.has(payload.id)) {
                subscription.projects.add(payload.id);
                retain(payload.id);
              }
            } else subscription.engineScope = true;
            return;
          }

          case 'unsubscribe': {
            if (frame.payload.scope === 'engine') {
              subscription.engineScope = false;
            } else if (frame.payload.scope === 'project') {
              if (frame.payload.id === undefined) releaseAll(subscription);
              else if (subscription.projects.delete(frame.payload.id)) release(frame.payload.id);
            } else if (frame.payload.scope === 'thread') {
              if (frame.payload.id === undefined) subscription.threads.clear();
              else subscription.threads.delete(frame.payload.id);
            } else if (frame.payload.id === undefined) {
              subscription.workflows.clear();
            } else {
              subscription.workflows.delete(frame.payload.id);
            }
            return;
          }

          case 'resume': {
            // Replay from the table, in seq order, for what this client is subscribed to — then
            // the live subscription above carries on from there (Arch §21.4). Persisted thread
            // frames (`chat.message`) replay by threadId, exactly as they route live (§2.5).
            const missed = await repository.events.listAfter(scope, frame.payload.afterSeq, {
              workflowIds: [...subscription.workflows],
              includeEngineScope: subscription.engineScope,
              threadIds: [...subscription.threads],
            });
            for (const event of missed) send(socket, event);
            return;
          }
        }
      }
    },

    closeAll(code = 1001) {
      for (const { socket, unsubscribe, subscription } of open) {
        unsubscribe();
        releaseAll(subscription);
        socket.close(code, 'engine shutting down');
      }
      open.clear();
    },
  };
}
