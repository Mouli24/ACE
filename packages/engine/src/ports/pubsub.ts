import type { Scope } from './scope.js';

/** Removes the subscription it was returned from. */
export type Unsubscribe = () => void;

/**
 * Live event fan-out (Arch §7: an in-process emitter locally, Redis pub/sub when hosted).
 * The WebSocket hub sits on top of this.
 */
export interface PubSub<TMessage> {
  publish(scope: Scope, topic: string, message: TMessage): Promise<void>;
  subscribe(
    scope: Scope,
    topic: string,
    handler: (message: TMessage) => void,
  ): Promise<Unsubscribe>;
}
