import type { Id } from '@ace/contracts';

import type {
  EngineEvent,
  NewEngineEvent,
  PubSub,
  Repository,
  Scope,
  Unsubscribe,
} from '../ports/index.js';

export * from './batcher.js';
export * from './ws-hub.js';

/** An event on its way in, before the log stamps it with a time and a seq. */
export type EmittedEvent = Omit<NewEngineEvent, 'createdAt'> & { createdAt?: string };

export interface EventBus {
  /** Persist, then publish. Returns the stored row, including the seq it was given. */
  emit(event: EmittedEvent): Promise<EngineEvent>;
  /**
   * Publish without persisting (round 2 §2.4). Only `node.token` uses this: a stream frame is
   * worth sending to a watching client and worth nothing in the log, where it would multiply the
   * rows of every run by the number of tokens generated.
   */
  emitTransient(event: EmittedEvent): Promise<void>;
  subscribe(handler: (event: EngineEvent) => void): Promise<Unsubscribe>;
}

export interface EventBusDeps {
  repository: Repository;
  scope: Scope;
  pubsub: PubSub<EngineEvent>;
  now?: () => string;
}

/** One topic; subscribers filter. A local engine has one process and one client to fan out to. */
const TOPIC = 'engine.events';

/**
 * The append-only event log and its live fan-out (FR-EXE-014, Arch §21.4).
 *
 * The order matters: an event is **persisted first**, then published. A subscriber therefore never
 * sees an event that a reconnecting client could not also replay from the table, which is what
 * makes `resume { afterSeq }` a complete catch-up rather than a best effort (NFR-REL-01).
 */
export function createEventBus({ repository, scope, pubsub, now }: EventBusDeps): EventBus {
  const timestamp = now ?? (() => new Date().toISOString());

  return {
    async emit(event) {
      const stored = await repository.events.append(scope, {
        ...event,
        createdAt: event.createdAt ?? timestamp(),
      });
      await pubsub.publish(scope, TOPIC, stored);
      return stored;
    },

    async emitTransient(event) {
      await pubsub.publish(scope, TOPIC, {
        ...event,
        // Never read: a transient event is not part of the sequence `resume` counts through.
        seq: 0,
        createdAt: event.createdAt ?? timestamp(),
        transient: true,
      });
    },

    subscribe: (handler) => pubsub.subscribe(scope, TOPIC, handler),
  };
}

/** The `workflow.updated` event a graph-ops batch produces (§2.9). */
export function workflowUpdatedEvent(workflowId: Id, version: number): EmittedEvent {
  return {
    type: 'workflow.updated',
    workflowId,
    payload: { workflowId, version },
  };
}
