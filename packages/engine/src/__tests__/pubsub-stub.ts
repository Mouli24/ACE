import type { PubSub, Scope, Unsubscribe } from '../ports/index.js';

/**
 * The engine may not import `@ace/storage-local` (CLAUDE.md §3.4 rule 3), so its tests carry their
 * own in-process PubSub. It is the same behaviour the local adapter provides.
 */
export class InProcessPubSubStub<TMessage> implements PubSub<TMessage> {
  readonly #handlers = new Map<string, Set<(message: TMessage) => void>>();

  async publish(scope: Scope, topic: string, message: TMessage): Promise<void> {
    for (const handler of [...(this.#handlers.get(this.#key(scope, topic)) ?? [])]) {
      handler(message);
    }
  }

  async subscribe(
    scope: Scope,
    topic: string,
    handler: (message: TMessage) => void,
  ): Promise<Unsubscribe> {
    const key = this.#key(scope, topic);
    const handlers = this.#handlers.get(key) ?? new Set();
    handlers.add(handler);
    this.#handlers.set(key, handlers);
    return () => handlers.delete(handler);
  }

  #key(scope: Scope, topic: string): string {
    return `${scope.workspaceId}::${topic}`;
  }
}
