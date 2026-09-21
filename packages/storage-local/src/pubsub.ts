import type { PubSub, Scope, Unsubscribe } from '@ace/engine';

/**
 * In-process fan-out (Arch §7 local adapter; Redis pub/sub when hosted). The WebSocket hub sits on
 * top of this, so delivery iterates a copy of the handler set — a subscriber that unsubscribes
 * while being delivered to must not disturb the others.
 */
export class InProcessPubSub<TMessage> implements PubSub<TMessage> {
  readonly #handlers = new Map<string, Set<(message: TMessage) => void>>();

  async publish(scope: Scope, topic: string, message: TMessage): Promise<void> {
    const handlers = this.#handlers.get(this.#key(scope, topic));
    if (handlers === undefined) return;

    for (const handler of [...handlers]) {
      handler(message);
    }
  }

  async subscribe(
    scope: Scope,
    topic: string,
    handler: (message: TMessage) => void,
  ): Promise<Unsubscribe> {
    const key = this.#key(scope, topic);
    let handlers = this.#handlers.get(key);
    if (handlers === undefined) {
      handlers = new Set();
      this.#handlers.set(key, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#handlers.delete(key);
    };
  }

  #key(scope: Scope, topic: string): string {
    return `${scope.workspaceId}::${topic}`;
  }
}
